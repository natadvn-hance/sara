import { AnalyticsView, ClientList, ClientView, MeetingList, newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../src/db/client'
import { account, chatMessage, conversation, deal, event, lead, meeting } from '../../src/db/schema'
import { stageOf } from '../../src/pult/clients'
import { buildTestApp, type TestApp } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)

const LEAD = '95000061'
const CONV = '99999999-9999-4999-8999-999999999961'
const DEAL = '99999999-9999-4999-8999-999999999962'
const QUIET = '99999999-9999-4999-8999-999999999963'

let t: TestApp

async function seed(d: Db) {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
  await d
    .insert(account)
    .values({ id: 'hance-marketing', title: 'Hance маркетинг', egressIp: '127.0.0.1' })
  await d.insert(lead).values({
    id: LEAD,
    accountId: 'hance-marketing',
    title: 'Стратегия для сети кофеен',
    category: 'Маркетинг',
    city: 'Краснодар',
    text: 'Нужна стратегия.',
    clientName: 'Ольга',
    bidPriceRub: 240,
    seenAt: ago(600),
    status: 'bid_sent',
    correlationId: newEventId(),
  })
  await d
    .insert(deal)
    .values({ id: DEAL, leadId: LEAD, accountId: 'hance-marketing', stage: 'talking' })
  await d.insert(conversation).values([
    {
      id: CONV,
      accountId: 'hance-marketing',
      chatId: 'chat-61',
      orderId: LEAD,
      dealId: DEAL,
      origin: 'sara',
      borisNote: '29.10: предложи созвон',
    },
    { id: QUIET, accountId: 'hance-marketing', chatId: 'chat-62', origin: 'v1' },
  ])
  await d.insert(chatMessage).values({
    id: newEventId(),
    accountId: 'hance-marketing',
    chatId: 'chat-61',
    orderId: LEAD,
    platformMessageId: 'm61',
    side: 'client',
    author: 'client',
    authorBasis: 'side',
    text: 'Давайте обсудим объём.',
    sentAt: ago(30),
    source: 'live',
    conversationId: CONV,
  })
  await d.insert(event).values([
    {
      id: newEventId(),
      type: 'bid.sent',
      v: 1,
      entityKind: 'lead',
      entityId: LEAD,
      accountId: 'hance-marketing',
      actor: 'sara',
      occurredAt: ago(500),
      correlationId: newEventId(),
      payload: { spent_rub: 240 },
    },
    {
      id: newEventId(),
      type: 'spend.recorded',
      v: 1,
      entityKind: 'lead',
      entityId: LEAD,
      accountId: 'hance-marketing',
      actor: 'sara',
      occurredAt: ago(500),
      correlationId: newEventId(),
      payload: { amount_rub: 240 },
    },
  ])
}

beforeEach(async () => {
  await resetDb(db)
  t = await buildTestApp(db)
  await t.app.inject({
    method: 'POST',
    url: '/api/setup/password',
    payload: { password: 'длинныйпароль1' },
  })
  await seed(db)
})
afterEach(() => t.close())

const get = async (url: string) => {
  const r = await t.app.inject({ method: 'GET', url, headers: { cookie: t.cookie() } })
  return { status: r.statusCode, body: r.json() as unknown }
}
const post = async (url: string, payload: object = {}) => {
  const r = await t.app.inject({ method: 'POST', url, payload, headers: { cookie: t.cookie() } })
  return { status: r.statusCode, body: r.json() as { message?: string; error?: string } }
}

describe('«Клиенты»: the stage, the note and the outcome', () => {
  it('FR-CONV-11, FR-ANL-5: a client has its stage from the deal; Boris’s outcome is the last word', () => {
    expect(stageOf({ outcome: null, closedAt: null }, 'talking')).toBe('Переговоры')
    expect(stageOf({ outcome: null, closedAt: null }, 'call_booked')).toBe('В работе')
    expect(stageOf({ outcome: 'won', closedAt: null }, 'talking')).toBe('Закрыта')
    expect(stageOf({ outcome: 'lost', closedAt: null }, 'call_done')).toBe('Отвалился')
    expect(stageOf({ outcome: null, closedAt: '2026-10-29' }, 'talking')).toBe('Отвалился')
    expect(stageOf({ outcome: null, closedAt: null }, null)).toBe('Отклик')
  })

  it('FR-CONV-11: the list and the screen carry the stage, the spend, Sara’s instruction and Boris’s note apart', async () => {
    const l = ClientList.parse((await get('/api/clients')).body)
    expect(l.rows.find((r) => r.id === CONV)).toMatchObject({
      name: 'Ольга',
      stage: 'Переговоры',
      owner: 'sara',
    })
    expect((await post(`/api/clients/${CONV}/note`, { text: 'сеть из 4 кофеен' })).body).toEqual({
      message: 'Заметку сохранила.',
    })
    const v = ClientView.parse((await get(`/api/clients/${CONV}`)).body)
    expect(v).toMatchObject({
      stage: 'Переговоры',
      spentRub: 240,
      note: 'сеть из 4 кофеен',
      instruction: '29.10: предложи созвон',
      outcome: null,
    })
    // Boris's note never becomes Sara's instruction.
    const [c] = await db.select().from(conversation).where(eq(conversation.id, CONV))
    expect(c?.borisNote).toBe('29.10: предложи созвон')
    expect((await get('/api/clients/not-a-uuid')).status).toBe(404)
  })

  it('FR-ANL-5, FR-MEET-4: a contract with its sum closes the deal and reaches the funnel, the log and the month', async () => {
    const r = await post(`/api/clients/${CONV}/outcome`, {
      outcome: 'won',
      amountRub: 120000,
      service: 'стратегия',
    })
    expect(r.body).toEqual({ message: 'Записала договор.' })
    const v = ClientView.parse((await get(`/api/clients/${CONV}`)).body)
    expect(v.stage).toBe('Закрыта')
    expect(v.outcome).toMatchObject({ outcome: 'won', amountRub: 120000 })
    expect(v.service).toBe('стратегия')
    const [d] = await db.select().from(deal).where(eq(deal.id, DEAL))
    expect(d?.stage).toBe('won')
    expect(await countEvents(db, 'client.outcome', CONV)).toBe(1)
    const a = AnalyticsView.parse(
      (await get(`/api/analytics?year=${new Date().getFullYear()}`)).body,
    )
    expect(a.clients[0]).toMatchObject({
      client: 'Ольга',
      stage: 'Закрыта',
      dealRub: 120000,
      service: 'стратегия',
    })
    expect(a.months.at(-1)).toMatchObject({
      won: 1,
      revenueRub: 120000,
      avgCheckRub: 120000,
      cacRub: 240,
    })
    expect(a.funnel.find((f) => f.stage === 'Закрыта')?.count).toBe(1)
  })

  it('FR-ANL-5: lost with a reason, and an outcome taken back', async () => {
    await post(`/api/clients/${CONV}/outcome`, { outcome: 'lost', reason: 'выбрал другого' })
    expect(ClientView.parse((await get(`/api/clients/${CONV}`)).body).outcome).toMatchObject({
      outcome: 'lost',
      reason: 'выбрал другого',
      amountRub: null,
    })
    expect((await post(`/api/clients/${CONV}/outcome`, { outcome: null })).body).toEqual({
      message: 'Итог убрала, сделка снова идёт.',
    })
    expect(ClientView.parse((await get(`/api/clients/${CONV}`)).body).outcome).toBeNull()
    expect((await post(`/api/clients/${CONV}/outcome`, { outcome: 'maybe' })).status).toBe(400)
  })
})

describe('«Встречи»', () => {
  it('FR-MEET-4: a call added by hand, the calls a chat speaks of beside it, and the outcome with a sum is the contract', async () => {
    await db.update(deal).set({ stage: 'call_proposed' }).where(eq(deal.id, DEAL))
    let l = MeetingList.parse((await get('/api/meetings')).body)
    expect(l.rows).toEqual([
      expect.objectContaining({
        id: `deal:${CONV}`,
        source: 'deal',
        clientName: 'Ольга',
        at: null,
      }),
    ])
    const at = new Date(Date.now() + 86_400_000).toISOString()
    expect(
      (
        await post('/api/meetings', {
          title: 'Созвон с Ольгой',
          at,
          channel: 'Zoom',
          clientId: CONV,
        })
      ).body,
    ).toEqual({
      message: 'Встречу записала.',
    })
    l = MeetingList.parse((await get('/api/meetings')).body)
    expect(l.rows).toHaveLength(1)
    expect(l.rows[0]).toMatchObject({
      title: 'Созвон с Ольгой',
      clientId: CONV,
      channel: 'Zoom',
      source: 'manual',
      at,
    })
    const [m] = await db.select().from(meeting)
    expect(
      (await post(`/api/meetings/${m?.id}/outcome`, { outcome: 'held', amountRub: 90000 })).status,
    ).toBe(200)
    const v = ClientView.parse((await get(`/api/clients/${CONV}`)).body)
    expect(v.meetings[0]).toMatchObject({ outcome: 'held', amountRub: 90000 })
    expect(v.outcome).toMatchObject({ outcome: 'won', amountRub: 90000 })
    expect((await post('/api/meetings', { title: '' })).status).toBe(400)
    expect(
      (await post(`/api/meetings/${newEventId()}/outcome`, { outcome: 'missed' })).status,
    ).toBe(404)
  })
})
