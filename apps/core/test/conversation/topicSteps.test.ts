import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureConversation, updateConversation } from '../../src/conversation/store'
import { resetFalseClosedSteps, topicStages, topicSteps } from '../../src/conversation/topicSteps'
import { deal, forumTopic, lead, topicStep } from '../../src/db/schema'
import { createDeal } from '../../src/domain/deal'
import { appendEvent } from '../../src/journal/journal'
import { topicName } from '../../src/notify/forum'
import type { Notifier } from '../../src/notify/notifier'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const ORDER = '95504921'
const ACC = 'hance-marketing'
let steps: { text: string; place: unknown; quiet: boolean | undefined }[]
let stages: { place: unknown; dot: string }[]
let forum = true
const notifier: Pick<Notifier, 'sendText' | 'setTopicStage' | 'forumOn'> = {
  sendText: async (text, o) => {
    steps.push({ text, place: o?.place, quiet: o?.quiet })
    return { messageId: 1 }
  },
  setTopicStage: async (place, dot) => {
    stages.push({ place, dot })
  },
  forumOn: async () => forum,
}
const deps = { db, notifier }

async function ev(
  type: 'profi.client_read' | 'deal.stage_changed' | 'profi.order_gone',
  e: {
    kind: string
    id: string
    payload: Record<string, unknown>
  },
) {
  await appendEvent(db, {
    type,
    v: 1,
    entity: { kind: e.kind, id: e.id },
    account_id: ACC,
    actor: 'profi',
    // After the topic was made: the journal's older news is not news.
    occurred_at: new Date(Date.now() + 5_000).toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: e.payload,
  })
}

beforeEach(async () => {
  await resetDb(db)
  steps = []
  stages = []
  forum = true
  await db.insert(lead).values({
    id: ORDER,
    accountId: ACC,
    title: 'Маркетинг',
    category: 'Маркетинг',
    city: 'Маринбург',
    text: 'Нужен маркетолог',
    clientName: 'Татьяна',
    bidPriceRub: 100,
    seenAt: new Date().toISOString(),
    correlationId: newEventId(),
  })
  await db.insert(forumTopic).values({
    chatId: -1001,
    key: ORDER,
    threadId: 7,
    name: topicName({ name: 'Татьяна', orderId: ORDER, title: 'Маркетинг' }),
  })
})

describe('the stage in the topic name', () => {
  it('ST-M7-16: a bid is yellow, talking light green, a booked call orange, a won deal ✅, a lost one red', async () => {
    const dealId = await createDeal(db, {
      leadId: ORDER,
      accountId: ACC,
      correlationId: newEventId(),
    })
    await topicStages(deps)
    expect(stages).toEqual([{ place: { order: ORDER }, dot: '🟡' }])
    const named = async (stage: string) => {
      await db.update(deal).set({ stage }).where(eq(deal.id, dealId))
      stages = []
      await topicStages(deps)
      return stages[0]?.dot
    }
    expect(await named('talking')).toBe('🟢')
    expect(await named('call_booked')).toBe('🟠')
    const conv = await ensureConversation(db, { accountId: ACC, chatId: ORDER, orderId: ORDER })
    await updateConversation(db, conv.id, { outcome: 'won' })
    expect(await named('call_booked')).toBe('✅')
    await updateConversation(db, conv.id, { outcome: 'lost' })
    expect(await named('call_booked')).toBe('🔴')
  })

  it('ST-M7-16: a topic that already shows its stage is not touched, and nothing happens without a forum', async () => {
    await db
      .update(forumTopic)
      .set({ name: `🟡 ${topicName({ name: 'Татьяна', orderId: ORDER, title: 'Маркетинг' })}` })
      .where(eq(forumTopic.key, ORDER))
    await topicStages(deps)
    expect(stages).toEqual([])
    forum = false
    await db.update(forumTopic).set({ name: 'Татьяна' }).where(eq(forumTopic.key, ORDER))
    await topicStages(deps)
    expect(stages).toEqual([])
  })

  it('ST-M7-16: a new topic is named with its stage', () => {
    expect(
      topicName({ name: 'Анжела', orderId: '95583456', title: 'Сделать анализ', stage: 'Отклик' }),
    ).toBe('🟡 Анжела · №95583456 · Сделать анализ')
  })
})

describe('the steps in the topic', () => {
  it('ST-M7-16: read, call booked and order closed are shown quietly, once each, from the journal', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: ORDER, orderId: ORDER })
    const dealId = await createDeal(db, {
      leadId: ORDER,
      accountId: ACC,
      correlationId: newEventId(),
    })
    await ev('profi.client_read', { kind: 'chat', id: ORDER, payload: { chat_id: conv.chatId } })
    await ev('profi.client_read', { kind: 'chat', id: ORDER, payload: { chat_id: conv.chatId } })
    await ev('deal.stage_changed', {
      kind: 'deal',
      id: dealId,
      payload: { from: 'talking', to: 'call_booked' },
    })
    await ev('profi.order_gone', { kind: 'order', id: ORDER, payload: {} })
    const closed = { ...deps, getOrder: async () => ({ open: false, from_page: true }) }
    expect(await topicSteps(closed, new Date())).toBe(3)
    expect(steps.map((s) => s.text.replace(/ · .*$/, '')).sort()).toEqual([
      '<i>👁 Клиент прочитал отклик',
      '<i>📁 Заказ закрыт на сайте',
      '<i>📞 Созвон назначен',
    ])
    expect(steps.every((s) => s.quiet && (s.place as { order: string }).order === ORDER)).toBe(true)
    // Never twice.
    expect(await topicSteps(closed, new Date())).toBe(0)
  })

  it('ST-M7-16: an order that left the board with a bid on it is not closed: the step waits for the page to say so', async () => {
    await ev('profi.order_gone', { kind: 'order', id: ORDER, payload: {} })
    // No way to read the page: never shown.
    expect(await topicSteps(deps, new Date())).toBe(0)
    // The page says open, or an old reading says closed: not shown.
    let answer = { open: true, from_page: true }
    const withPage = { ...deps, getOrder: async () => answer }
    expect(await topicSteps(withPage, new Date())).toBe(0)
    answer = { open: false, from_page: false }
    expect(await topicSteps(withPage, new Date(Date.now() + 40 * 60_000))).toBe(0)
    expect(steps).toEqual([])
    // The page itself says closed: shown, once.
    answer = { open: false, from_page: true }
    expect(await topicSteps(withPage, new Date(Date.now() + 80 * 60_000))).toBe(1)
    expect(steps.map((x) => x.text.replace(/ · .*$/, ''))).toEqual(['<i>📁 Заказ закрыт на сайте'])
    expect(await topicSteps(withPage, new Date(Date.now() + 120 * 60_000))).toBe(0)
  })

  it('ST-M7-16: the false «закрыт» marks of before are cleared once', async () => {
    await db.insert(topicStep).values([
      { key: ORDER, step: 'order_closed' },
      { key: ORDER, step: 'read' },
    ])
    expect(await resetFalseClosedSteps(db)).toBe(1)
    expect(await resetFalseClosedSteps(db)).toBe(0)
    expect((await db.select().from(topicStep)).map((r) => r.step)).toEqual(['read'])
  })

  it('ST-M7-16: news from before the topic, and a stage that is not a call, show nothing', async () => {
    const dealId = await createDeal(db, {
      leadId: ORDER,
      accountId: ACC,
      correlationId: newEventId(),
    })
    await ev('deal.stage_changed', {
      kind: 'deal',
      id: dealId,
      payload: { from: 'bid_sent', to: 'talking' },
    })
    await appendEvent(db, {
      type: 'profi.order_gone',
      v: 1,
      entity: { kind: 'order', id: ORDER },
      account_id: ACC,
      actor: 'profi',
      occurred_at: new Date(Date.now() - 3600_000).toISOString(),
      causation_id: null,
      correlation_id: newEventId(),
      reason: null,
      payload: {},
    })
    expect(await topicSteps(deps, new Date())).toBe(0)
    forum = false
    expect(await topicSteps(deps, new Date())).toBe(0)
  })
})
