import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { backfillTalking, promoteOnClientWord } from '../../src/conversation/stage'
import { ensureConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import { topicStages } from '../../src/conversation/topicSteps'
import { deal, forumTopic, lead } from '../../src/db/schema'
import { advanceTo, createDeal, pathBetween } from '../../src/domain/deal'
import { appendEvent } from '../../src/journal/journal'
import { STAGE_DOT, topicName, withoutDot } from '../../src/notify/forum'
import { logRows } from '../../src/pult/analytics'
import { stageForKey } from '../../src/pult/clients'
import { EPOCH, sheetValues } from '../../src/sheet/sync'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)

const ORDER = '95596098'
const ACC = 'hance-marketing'
let dealId: string

beforeEach(async () => {
  await resetDb(db)
  await db.insert(lead).values({
    id: ORDER,
    accountId: ACC,
    title: 'Психотерапевт',
    category: 'Маркетинг',
    city: 'Москва',
    text: 'Нужна помощь',
    clientName: 'Психотерапевт',
    bidPriceRub: 290,
    seenAt: new Date().toISOString(),
    correlationId: newEventId(),
    status: 'bid_sent',
  })
  dealId = await createDeal(db, { leadId: ORDER, accountId: ACC, correlationId: newEventId() })
  await appendEvent(db, {
    type: 'bid.sent',
    v: 1,
    entity: { kind: 'lead', id: ORDER },
    account_id: ACC,
    actor: 'sara',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { spent_rub: 290 },
  })
})

const stageNow = async () => (await db.select().from(deal).where(eq(deal.id, dealId)))[0]?.stage

describe('the path of a deal', () => {
  it('FR-CONV-1: the shortest allowed way, each step a stage of its own', () => {
    expect(pathBetween('bid_sent', 'talking')).toEqual(['talking'])
    expect(pathBetween('bid_sent', 'call_booked')).toEqual([
      'talking',
      'call_proposed',
      'call_booked',
    ])
    expect(pathBetween('call_booked', 'talking')).toHaveLength(2)
    expect(pathBetween('won', 'talking')).toBeNull()
    expect(pathBetween('talking', 'talking')).toEqual([])
  })

  it('FR-CONV-1: a deal moves along the steps, journaled each, and a deal already there stays', async () => {
    expect(
      await advanceTo(db, {
        dealId,
        to: 'call_booked',
        actor: 'boris',
        reason: 't',
        correlationId: newEventId(),
      }),
    ).toBe(true)
    expect(await stageNow()).toBe('call_booked')
    // bid_sent was journaled at the creation, then three moves.
    expect(await countEvents(db, 'deal.stage_changed')).toBe(4)
    expect(
      await advanceTo(db, {
        dealId,
        to: 'talking',
        actor: 'sara',
        reason: 't',
        correlationId: newEventId(),
      }),
    ).toBe(true)
    expect(
      await advanceTo(db, {
        dealId,
        to: 'talking',
        actor: 'sara',
        reason: 't',
        correlationId: newEventId(),
      }),
    ).toBe(false)
  })
})

describe('the first word of a client', () => {
  it('FR-CONV-1: reading the chat with his word moves the deal to talking, whoever reads it', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: ORDER, orderId: ORDER })
    await syncChat(
      {
        db,
        profi: stubProfi([
          chatMsg('m1', 'specialist', 'Отклик', '2026-11-01T10:00:00.000Z'),
          chatMsg('m2', 'client', 'Здравствуйте', '2026-11-01T10:05:00.000Z'),
          chatMsg('m3', 'system', 'Сообщите, если договоритесь', '2026-11-01T10:05:01.000Z'),
        ]),
      },
      conv,
      new Date('2026-11-01T10:06:00Z'),
      { v1Writes: false },
    )
    expect(await stageNow()).toBe('talking')
  })

  it('FR-CONV-1: a bid nobody answered stays; a dormant deal wakes; a booked call is not pulled back', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: ORDER, orderId: ORDER })
    await syncChat(
      { db, profi: stubProfi([chatMsg('m1', 'specialist', 'Отклик', '2026-11-01T10:00:00.000Z')]) },
      conv,
      new Date('2026-11-01T10:06:00Z'),
      { v1Writes: false },
    )
    expect(await stageNow()).toBe('bid_sent')
    await db.update(deal).set({ stage: 'dormant' }).where(eq(deal.id, dealId))
    expect(await promoteOnClientWord(db, conv)).toBe(true)
    expect(await stageNow()).toBe('talking')
    await db.update(deal).set({ stage: 'call_booked' }).where(eq(deal.id, dealId))
    expect(await promoteOnClientWord(db, conv)).toBe(false)
    expect(await stageNow()).toBe('call_booked')
  })

  it('FR-CONV-1: the one-time pass moves the deals whose client already wrote, once, and sends nothing', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: ORDER, orderId: ORDER })
    // The word is in the chat, and the deal never moved (as it was).
    await syncChat(
      {
        db,
        profi: stubProfi([chatMsg('m2', 'client', 'Здравствуйте', '2026-11-01T10:05:00.000Z')]),
      },
      conv,
      new Date('2026-11-01T10:06:00Z'),
      { v1Writes: false },
    )
    await db.update(deal).set({ stage: 'bid_sent' }).where(eq(deal.id, dealId))
    expect(await backfillTalking(db)).toBe(1)
    expect(await stageNow()).toBe('talking')
    await db.update(deal).set({ stage: 'bid_sent' }).where(eq(deal.id, dealId))
    expect(await backfillTalking(db)).toBe(0)
    expect(await stageNow()).toBe('bid_sent')
  })
})

describe('one stage for the topic, the log and the sheet', () => {
  it('ST-M7-16: the client answers: the circle turns green, the log and the sheet say «Переговоры»', async () => {
    const named: { place: unknown; dot: string }[] = []
    await db.insert(forumTopic).values({
      chatId: -1001,
      key: ORDER,
      threadId: 7,
      name: topicName({
        name: 'Психотерапевт',
        orderId: ORDER,
        title: 'Психотерапевт',
        stage: 'Отклик',
      }),
    })
    const deps = {
      db,
      notifier: {
        sendText: async () => ({ messageId: 1 }),
        setTopicStage: async (place: unknown, dot: string) => {
          named.push({ place, dot })
        },
        forumOn: async () => true,
      },
    }
    await topicStages(deps)
    expect(named).toEqual([])
    expect((await logRows(db, { since: EPOCH }))[0]?.stage).toBe('Отклик')
    const conv = await ensureConversation(db, { accountId: ACC, chatId: ORDER, orderId: ORDER })
    await syncChat(
      {
        db,
        profi: stubProfi([chatMsg('m2', 'client', 'Здравствуйте', '2026-11-01T10:05:00.000Z')]),
      },
      conv,
      new Date('2026-11-01T10:06:00Z'),
      { v1Writes: false },
    )
    expect(await stageForKey(db, ORDER)).toBe('Переговоры')
    await topicStages(deps)
    expect(named).toEqual([{ place: { order: ORDER }, dot: '🟢' }])
    const row = (await logRows(db, { since: EPOCH }))[0]
    expect(row?.stage).toBe('Переговоры')
    expect(row && sheetValues(row).stage).toBe('Переговоры')
  })

  it('ST-M7-16: the colours of Boris, and an old circle never stays beside a new one', () => {
    expect(STAGE_DOT).toEqual({
      Отклик: '🟡',
      Переговоры: '🟢',
      'В работе': '🟠',
      Закрыта: '✅',
      Отвалился: '🔴',
    })
    expect(withoutDot('🔵 Роберт · №1')).toBe('Роберт · №1')
    expect(withoutDot('🟡 🟡 Роберт · №1')).toBe('Роберт · №1')
    expect(withoutDot('✅ 🔵 Роберт')).toBe('Роберт')
    expect(withoutDot('Роберт')).toBe('Роберт')
  })
})
