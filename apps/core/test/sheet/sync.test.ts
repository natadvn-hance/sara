import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  account,
  chatMessage,
  conversation,
  deal,
  event,
  lead,
  outbox,
  sheetRow,
} from '../../src/db/schema'
import { analyticsView } from '../../src/pult/analytics'
import { type SheetOp, sheetPart, startSheetSync } from '../../src/sheet/sync'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const URL = 'https://script.google.com/macros/s/made-up/exec'
const SECRET = 'cd'.repeat(24)
const LINKED = new Date('2026-10-15T09:00:00Z')
const at = (min: number) => new Date(LINKED.getTime() + min * 60_000)

/**
 * Boris's sheet as the script keeps it: a row per order, a cell written only while it holds what Sara wrote last.
 * `down` makes Google not answer; `boris` changes a cell by hand.
 */
function fakeGoogle() {
  const rows = new Map<string, Record<string, string | number>>()
  const calls: { ops?: SheetOp[]; ping?: boolean }[] = []
  let down = false
  const f = (async (_url: string, init: { body: string }) => {
    if (down) throw new Error('connect ETIMEDOUT')
    const body = JSON.parse(init.body)
    if (body.secret !== SECRET) return Response.json({ ok: false, error: 'secret' })
    calls.push(body)
    if (body.ping) return Response.json({ ok: true, sheet: '📋 Лог клиентов', rows: rows.size })
    const results = (body.ops as SheetOp[]).map((op) => {
      const row = rows.get(op.key)
      if (!row) {
        if (!op.create) return { key: op.key, status: 'gone' }
        rows.set(op.key, { ...op.values } as Record<string, string | number>)
        return { key: op.key, status: 'created', written: Object.keys(op.values), kept: [] }
      }
      const written: string[] = []
      const kept: string[] = []
      for (const [c, v] of Object.entries(op.values)) {
        if (String(row[c] ?? '') === String(v)) written.push(c)
        else if (String(row[c] ?? '') === String((op.expect as Record<string, unknown>)[c] ?? '')) {
          row[c] = v as string | number
          written.push(c)
        } else kept.push(c)
      }
      return { key: op.key, status: 'updated', written, kept }
    })
    return Response.json({ ok: true, results })
  }) as unknown as typeof fetch
  return {
    fetch: f,
    rows,
    calls,
    set down(v: boolean) {
      down = v
    },
    boris(key: string, column: string, value: string | number) {
      const row = rows.get(key)
      if (row) row[column] = value
    },
  }
}

async function bid(o: {
  id: string
  name: string
  title: string
  min: number
  fee: number
  quote: number | null
}) {
  await db.insert(lead).values({
    id: o.id,
    accountId: 'hance-marketing',
    title: o.title,
    category: 'Маркетинг',
    city: 'Краснодар',
    text: 'Текст заказа',
    clientName: o.name,
    bidPriceRub: o.fee,
    seenAt: at(o.min - 5).toISOString(),
    status: 'bid_sent',
    correlationId: newEventId(),
  })
  await db.insert(outbox).values({
    id: newEventId(),
    kind: 'bid',
    idempotencyKey: `bid:${o.id}`,
    state: 'confirmed',
    payload: {
      leadId: o.id,
      accountId: 'hance-marketing',
      priceRub: o.fee,
      servicePriceRub: o.quote,
    },
  })
  await db.insert(deal).values({
    id: newEventId(),
    leadId: o.id,
    accountId: 'hance-marketing',
    stage: 'bid_sent',
  })
  const ev = (type: string, payload: object) => ({
    id: newEventId(),
    type,
    v: 1,
    entityKind: 'lead',
    entityId: o.id,
    accountId: 'hance-marketing',
    actor: 'sara',
    occurredAt: at(o.min).toISOString(),
    correlationId: newEventId(),
    payload,
  })
  await db
    .insert(event)
    .values([ev('bid.sent', { spent_rub: o.fee }), ev('spend.recorded', { amount_rub: o.fee })])
}

const sync = (g: ReturnType<typeof fakeGoogle>, url: string | undefined = URL) =>
  startSheetSync({ db, url, secret: SECRET, fetch: g.fetch, tickMs: 3600_000 })

beforeEach(async () => {
  await resetDb(db)
  await db
    .insert(account)
    .values({ id: 'hance-marketing', title: 'Hance маркетинг', egressIp: '127.0.0.1' })
})

describe('Boris Google Sheet', () => {
  it('FR-ANL-7: a bid is a row in his formats, once, with the same numbers as the pult', async () => {
    const g = fakeGoogle()
    const s = sync(g)
    expect(await s.tick(at(0))).toEqual({ state: 'idle' })
    await bid({
      id: '95000101',
      name: 'Гена',
      title: 'Сайт для студии йоги',
      min: 5 * 24 * 60,
      fee: 437,
      quote: 30000,
    })
    expect(await s.tick(at(5 * 24 * 60 + 1))).toEqual({ state: 'sent', ops: 1 })
    expect(g.rows.get('95000101')).toEqual({
      month: 'Октябрь',
      client: 'Гена',
      service: 'Сайт',
      stage: 'Отклик',
      deal: 30000,
      spend: 437,
      ltv: '',
      note: '',
    })
    expect(await s.tick(at(5 * 24 * 60 + 2))).toEqual({ state: 'idle' })
    expect(g.calls.filter((c) => c.ops)).toHaveLength(1)
    const pult = (await analyticsView(db, 2026)).clients[0]
    expect(pult).toMatchObject({
      month: 'Октябрь',
      client: 'Гена',
      service: 'Сайт',
      stage: 'Отклик',
      dealRub: 30000,
      spendRub: 437,
    })
    s.stop()
  })

  it('FR-ANL-7: a stage that moves updates the same row; a cell Boris changed stays his', async () => {
    const g = fakeGoogle()
    const s = sync(g)
    await s.tick(at(0))
    await bid({
      id: '95000102',
      name: 'Лена',
      title: 'Консультация по продвижению',
      min: 10,
      fee: 120,
      quote: 5000,
    })
    await s.tick(at(11))
    g.boris('95000102', 'deal', 7000)
    await db.update(deal).set({ stage: 'talking' }).where(eq(deal.leadId, '95000102'))
    await s.tick(at(20))
    const last = g.calls.at(-1)?.ops?.[0]
    expect(last).toEqual({
      key: '95000102',
      create: false,
      values: { stage: 'Переговоры' },
      expect: { stage: 'Отклик' },
    })
    expect(g.rows.get('95000102')).toMatchObject({
      stage: 'Переговоры',
      deal: 7000,
      service: 'Консультация',
    })
    // Boris names the contract in the pult: the stage goes, the sum he typed in the sheet stays his.
    await db.insert(conversation).values({
      id: newEventId(),
      accountId: 'hance-marketing',
      chatId: 'chat-102',
      orderId: '95000102',
      origin: 'sara',
      outcome: 'won',
      amountRub: 45000,
    })
    await s.tick(at(30))
    expect(g.calls.at(-1)?.ops?.[0]).toMatchObject({
      values: { stage: 'Закрыта', deal: 45000, ltv: 45000 },
    })
    expect(g.rows.get('95000102')).toMatchObject({ stage: 'Закрыта', deal: 7000, ltv: 45000 })
    const [r] = await db.select().from(sheetRow).where(eq(sheetRow.orderId, '95000102'))
    expect(r?.boris).toEqual(['deal'])
    const n = g.calls.length
    await s.tick(at(40))
    expect(g.calls).toHaveLength(n)
    s.stop()
  })

  it('FR-ANL-7: a bid Profi.ru gave back drops off, costs nothing and says «Вернули на баланс»', async () => {
    const g = fakeGoogle()
    const s = sync(g)
    await s.tick(at(0))
    await bid({
      id: '95000103',
      name: 'Ира',
      title: 'Маркетинговая стратегия',
      min: 10,
      fee: 300,
      quote: 20000,
    })
    await db.insert(chatMessage).values({
      id: newEventId(),
      accountId: 'hance-marketing',
      chatId: 'chat-103',
      orderId: '95000103',
      platformMessageId: 'p1',
      side: 'specialist',
      author: 'system',
      authorBasis: 'side',
      text: 'Вернули на баланс 300 руб.',
      sentAt: at(60).toISOString(),
      source: 'live',
    })
    await s.tick(at(61))
    expect(g.rows.get('95000103')).toMatchObject({
      service: 'Стратегия',
      stage: 'Отвалился',
      deal: 20000,
      spend: 0,
      note: 'Вернули на баланс',
    })
    expect((await analyticsView(db, 2026)).months.at(-1)).toMatchObject({
      bids: 1,
      lost: 1,
      spendRub: 0,
    })
    s.stop()
  })

  it('FR-ANL-7: bids from before the link and test orders never reach the sheet', async () => {
    const g = fakeGoogle()
    const s = sync(g)
    await bid({ id: '95000104', name: 'Олег', title: 'Сайт', min: -60, fee: 100, quote: 10000 })
    await s.tick(at(0))
    await bid({ id: '9912345678', name: 'Тест', title: 'Сайт', min: 5, fee: 0, quote: 1000 })
    await bid({ id: '99123456789', name: 'Тест', title: 'Сайт', min: 6, fee: 0, quote: 1000 })
    await s.tick(at(10))
    expect(g.rows.size).toBe(0)
    expect(g.calls.some((c) => c.ops)).toBe(false)
    s.stop()
  })

  it('FR-ANL-7: Google down does not stop Sara; the sheet waits, retries with a pause and shows its lag', async () => {
    const g = fakeGoogle()
    const s = sync(g)
    await s.tick(at(0))
    await bid({ id: '95000105', name: 'Вера', title: 'Сайт', min: 10, fee: 200, quote: 15000 })
    g.down = true
    expect(await s.tick(at(11))).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('Google не ответил'),
    })
    expect(await s.tick(at(11.5))).toEqual({ state: 'waiting' })
    expect(await sheetPart(db, true, at(12))).toMatchObject({ id: 'sheet', tone: 'warn' })
    expect(await s.tick(at(12))).toMatchObject({ state: 'failed' })
    const part = await sheetPart(db, true, at(30))
    expect(part).toMatchObject({
      tone: 'bad',
      text: expect.stringContaining('Таблица отстала: 1 строка ждёт'),
    })
    expect(part?.fix).toContain('Google не ответил')
    g.down = false
    expect(await s.tick(at(31))).toEqual({ state: 'sent', ops: 1 })
    expect(await sheetPart(db, true, at(32))).toMatchObject({
      tone: 'ok',
      text: 'Пишет отклики в «Лог клиентов»',
    })
    s.stop()
  })

  it('FR-ANL-7: a row Boris deleted is left alone; no link, no sheet', async () => {
    const g = fakeGoogle()
    const s = sync(g)
    await s.tick(at(0))
    await bid({ id: '95000106', name: 'Таня', title: 'Сайт', min: 10, fee: 200, quote: 15000 })
    await s.tick(at(11))
    g.rows.delete('95000106')
    await db.update(deal).set({ stage: 'talking' }).where(eq(deal.leadId, '95000106'))
    await s.tick(at(20))
    await db.update(deal).set({ stage: 'lost' }).where(eq(deal.leadId, '95000106'))
    await s.tick(at(30))
    expect(g.rows.size).toBe(0)
    expect(g.calls.filter((c) => c.ops)).toHaveLength(2)
    const off = startSheetSync({ db, url: undefined, secret: SECRET, fetch: g.fetch })
    expect(await off.tick()).toEqual({ state: 'off' })
    expect(await sheetPart(db, false, at(40))).toBeNull()
  })
})
