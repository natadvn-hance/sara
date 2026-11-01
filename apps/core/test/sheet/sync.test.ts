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
import { onSheetPress } from '../../src/sheet/backfill'
import {
  SHEET_TASK_ID,
  type SheetOp,
  sheetPart,
  stageWins,
  startSheetSync,
} from '../../src/sheet/sync'
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
  const calls: { ops?: SheetOp[]; ping?: boolean; preview?: boolean }[] = []
  /** What the script would say to an op that looks for Boris's own row: his row taken, or a doubt. */
  const plan: Record<string, Record<string, unknown>> = {}
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
        const p = op.match ? plan[op.key] : undefined
        if (p) {
          if (!body.preview && p.status === 'adopted')
            rows.set(op.key, { ...(p.current as Record<string, string | number>) })
          return { key: op.key, ...p }
        }
        if (body.preview) return { key: op.key, status: 'created', written: [], kept: [] }
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
    plan,
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

/** Boris's chat: what Sara sent him and which messages she marked decided. */
function fakeChat() {
  const sent: { text: string; rows?: { text: string; callbackData: string }[][] }[] = []
  const done: [number, string][] = []
  return {
    sent,
    done,
    notifier: {
      sendButtons: async (text: string, rows: { text: string; callbackData: string }[][]) => {
        sent.push({ text, rows })
        return { messageId: 700 + sent.length }
      },
      sendText: async (text: string) => {
        sent.push({ text })
        return { messageId: 700 + sent.length }
      },
    },
    markDone: async (id: number, note: string) => {
      done.push([id, note])
    },
  }
}

const withChat = (g: ReturnType<typeof fakeGoogle>, chat: ReturnType<typeof fakeChat>) =>
  startSheetSync({
    db,
    url: URL,
    secret: SECRET,
    fetch: g.fetch,
    tickMs: 3600_000,
    notifier: chat.notifier,
  })

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
    await bid({ id: '99123456780', name: 'Тест', title: 'Сайт', min: 5, fee: 0, quote: 1000 })
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
      text: expect.stringContaining('Таблица отстала: 1 строка ждет'),
    })
    expect(part?.fix).toContain('Google не ответил')
    g.down = false
    expect(await s.tick(at(31))).toEqual({ state: 'sent', ops: 1 })
    expect(await sheetPart(db, true, at(32))).toMatchObject({
      tone: 'ok',
      text: 'Пишет отклики в «Лог клиентов».',
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

  describe('the past bids', () => {
    const DAY = 24 * 60
    const old = async () => {
      await bid({
        id: '95000201',
        name: 'Ольга',
        title: 'Сайт',
        min: -30 * DAY,
        fee: 300,
        quote: 20000,
      })
      await bid({
        id: '95000202',
        name: 'Артем',
        title: 'Консультация',
        min: -20 * DAY,
        fee: 100,
        quote: 5000,
      })
      await bid({
        id: '95000203',
        name: 'Игорь',
        title: 'Стратегия',
        min: -10 * DAY,
        fee: 150,
        quote: 30000,
      })
    }
    const BORIS_ROW = {
      month: 'Сентябрь',
      client: 'Ольга',
      service: 'Сайт',
      stage: 'Отвалился',
      deal: 25000,
      spend: 280,
      ltv: '',
      note: 'Звонили',
    }

    it('FR-ANL-7: the past bids are shown to Boris first, with counts and names, and nothing is written', async () => {
      const g = fakeGoogle()
      const chat = fakeChat()
      const s = withChat(g, chat)
      await old()
      g.plan['95000201'] = { status: 'adopted', current: BORIS_ROW }
      g.plan['95000202'] = { status: 'doubt', reason: '2 строки с этим именем в месяце' }
      await s.tick(at(0))
      expect(chat.sent).toHaveLength(1)
      const m = chat.sent[0]
      expect(m?.text).toContain('Всего: 3.')
      expect(m?.text).toContain('Добавлю новых строк: 1.')
      expect(m?.text).toContain('Сопоставлю с твоими строками (они уже есть, не дублирую): 1.')
      expect(m?.text).toContain('Под вопросом, не вношу (1): Артем, Сентябрь.')
      expect(m?.text).not.toContain('\u2014')
      expect(m?.rows?.[0]?.map((b) => b.text)).toEqual(['Внести', 'Не вносить'])
      expect(m?.rows?.[0]?.[0]?.callbackData).toBe(`t:${SHEET_TASK_ID}:apply`)
      // Preview only: nothing in the sheet, nothing in the queue, and it is asked once.
      expect(g.rows.size).toBe(0)
      expect(await db.select().from(sheetRow)).toHaveLength(0)
      await s.tick(at(5))
      await s.tick(at(10))
      expect(chat.sent).toHaveLength(1)
      expect(g.calls.filter((c) => c.preview)).toHaveLength(1)
      expect(await sheetPart(db, true, at(11))).toMatchObject({
        tone: 'warn',
        text: expect.stringContaining('Жду твоего ответа про прошлые отклики'),
      })
      s.stop()
    })

    it('FR-ANL-7: «Внести» writes them: new rows, Boris\u2019s own row taken without a twin, doubts left to him', async () => {
      const g = fakeGoogle()
      const chat = fakeChat()
      const s = withChat(g, chat)
      await old()
      g.plan['95000201'] = { status: 'adopted', current: BORIS_ROW }
      g.plan['95000202'] = { status: 'doubt', reason: '2 строки с этим именем в месяце' }
      await s.tick(at(0))
      expect(await onSheetPress({ db, notifier: chat }, 'apply')).toBe(
        'Вношу прошлые отклики в таблицу, это займет несколько минут.',
      )
      expect(chat.done).toEqual([[701, 'Вношу']])
      expect(await s.tick(at(5))).toEqual({ state: 'sent', ops: 3 })
      // A new row for the third, Boris's row labelled for the first, nothing for the doubtful second.
      expect(g.rows.get('95000203')).toMatchObject({ client: 'Игорь', stage: 'Отклик', spend: 150 })
      expect(g.rows.has('95000202')).toBe(false)
      const [first] = await db.select().from(sheetRow).where(eq(sheetRow.orderId, '95000201'))
      // His cells stay his, Sara has no cell to change here: she says «Отклик», his row says «Отвалился».
      expect(first?.boris).toEqual(['month', 'client', 'service', 'stage', 'deal', 'spend', 'note'])
      const [second] = await db.select().from(sheetRow).where(eq(sheetRow.orderId, '95000202'))
      expect(second).toMatchObject({ state: 'doubt' })
      expect(second?.written._doubt).toContain('Артем, Сентябрь')
      // The pass after finds nothing left, says so once, and a rerun duplicates nothing.
      const n = g.calls.filter((c) => c.ops && !c.preview).length
      expect(await s.tick(at(10))).toEqual({ state: 'idle' })
      expect(chat.sent).toHaveLength(2)
      expect(chat.sent[1]?.text).toContain('Добавила строк: 1. Сопоставила с твоими: 1.')
      expect(chat.sent[1]?.text).toContain('Не внесла, нужно твое решение (1): Артем, Сентябрь')
      await s.tick(at(15))
      expect(g.calls.filter((c) => c.ops && !c.preview)).toHaveLength(n)
      expect(chat.sent).toHaveLength(2)
      expect(g.rows.size).toBe(2)
      s.stop()
    })

    it('FR-ANL-7: without a press nothing moves; «Не вносить» keeps it so; a second press does nothing', async () => {
      const g = fakeGoogle()
      const chat = fakeChat()
      const s = withChat(g, chat)
      await old()
      await s.tick(at(0))
      await s.tick(at(30))
      expect(g.rows.size).toBe(0)
      expect(await onSheetPress({ db, notifier: chat }, 'drop')).toBe(
        'Хорошо, прошлые отклики в таблицу не вношу.',
      )
      expect(await onSheetPress({ db, notifier: chat }, 'apply')).toBe('Это уже решено.')
      await s.tick(at(40))
      expect(g.rows.size).toBe(0)
      s.stop()
    })

    it('FR-ANL-7: with no past bids nothing is asked', async () => {
      const g = fakeGoogle()
      const chat = fakeChat()
      const s = withChat(g, chat)
      await s.tick(at(0))
      expect(chat.sent).toHaveLength(0)
      s.stop()
    })

    it('FR-ANL-7: in Boris\u2019s own row Sara changes the stage only when she is further on, and fills only empty cells', async () => {
      expect(stageWins('Закрыта', 'Отклик')).toBe(true)
      expect(stageWins('Переговоры', 'Отклик')).toBe(true)
      expect(stageWins('Отклик', 'Переговоры')).toBe(false)
      expect(stageWins('Отвалился', 'Переговоры')).toBe(true)
      expect(stageWins('Отвалился', 'Закрыта')).toBe(false)
      expect(stageWins('Отклик', 'Закрыта')).toBe(false)
      expect(stageWins('Отклик', 'что-то свое')).toBe(true)
      const g = fakeGoogle()
      const chat = fakeChat()
      const s = withChat(g, chat)
      await bid({
        id: '95000301',
        name: 'Ольга',
        title: 'Сайт',
        min: -5 * DAY,
        fee: 300,
        quote: 20000,
      })
      g.plan['95000301'] = {
        status: 'adopted',
        current: { ...BORIS_ROW, stage: 'Отклик', deal: '', spend: '' },
      }
      await s.tick(at(0))
      await onSheetPress({ db, notifier: chat }, 'apply')
      await s.tick(at(5))
      // The empty cells are Sara's to fill; the cells with something in them are Boris's.
      await db.update(deal).set({ stage: 'talking' }).where(eq(deal.leadId, '95000301'))
      await s.tick(at(10))
      expect(g.rows.get('95000301')).toMatchObject({
        stage: 'Переговоры',
        deal: 20000,
        spend: 300,
        note: 'Звонили',
        client: 'Ольга',
      })
      const [r] = await db.select().from(sheetRow).where(eq(sheetRow.orderId, '95000301'))
      expect(r?.boris).toEqual(['month', 'client', 'service', 'note'])
      s.stop()
    })
  })
})
