import { newEventId } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, lead, leadScore, outbox, task } from '../../src/db/schema'
import { saveProfile, seedProfile } from '../../src/direction/profile'
import { decideRoute, recordCandidate } from '../../src/direction/router'
import { seedDirection } from '../../src/direction/store'
import type { Gateway } from '../../src/gateway/gateway'
import { type BidPayload, recordBid } from '../../src/leads/outbox'
import { createLeadPipeline, type LeadPipeline } from '../../src/leads/pipeline'
import { TEXTS } from '../../src/notify/cards'
import type { Notifier } from '../../src/notify/notifier'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const bid = (accountId: string, over: Partial<BidPayload> = {}): BidPayload => ({
  leadId: '7001',
  accountId,
  text: 'Ирина, добрый день!\n\nПонимаю задачу.',
  correlationId: newEventId(),
  title: 'Сайт',
  priceRub: 200,
  ...over,
})
const count = async (type: string) =>
  (await db.select().from(event).where(eq(event.type, type))).length

async function route(orderId: string, winner: 'a' | 'b') {
  for (const [acc, margin] of [
    ['a', winner === 'a' ? 9 : 1],
    ['b', winner === 'b' ? 9 : 1],
  ] as const)
    await recordCandidate(db, orderId, {
      accountId: acc,
      score: 60,
      decision: 'show',
      stopFactor: null,
      margin,
    })
  await decideRoute(db, orderId, newEventId())
}

beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  await seedProfile(db, 'hance-marketing')
  await saveProfile(db, 'a', { state: 'on' }, 'boris')
  await saveProfile(db, 'b', { state: 'on' }, 'boris')
})

describe('one bid per order', () => {
  it('FR-LEAD-4: two bids on one order are impossible', async () => {
    // Two accounts press at once from two cards: one row in the outbox and one request in the journal.
    const results = await Promise.all([
      db.transaction((tx) => recordBid(tx, bid('a'))),
      db.transaction((tx) => recordBid(tx, bid('b'))),
    ])
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(await db.select().from(outbox)).toHaveLength(1)
    expect(await count('bid.requested')).toBe(1)
  })

  it('FR-LEAD-4: the database refuses a second bid row for an order even with another key', async () => {
    await db.transaction((tx) => recordBid(tx, bid('a')))
    await expect(
      db.insert(outbox).values({
        id: newEventId(),
        kind: 'bid',
        idempotencyKey: 'bid:other-key',
        payload: bid('b'),
      }),
    ).rejects.toThrow()
    expect(await db.select().from(outbox)).toHaveLength(1)
    // A message row of the conversation, which has no leadId, is not a bid and is not held to it.
    await db.insert(outbox).values({
      id: newEventId(),
      kind: 'message',
      idempotencyKey: 'msg:1',
      payload: { chatId: 'c' },
    })
    await db.insert(outbox).values({
      id: newEventId(),
      kind: 'message',
      idempotencyKey: 'msg:2',
      payload: { chatId: 'c' },
    })
  })

  it('FR-LEAD-4: recordBid refuses an account that lost the route and writes nothing', async () => {
    await route('7001', 'a')
    const r = await db.transaction((tx) => recordBid(tx, bid('b')))
    expect(r).toEqual({ outboxId: null, created: false })
    expect(await db.select().from(outbox)).toHaveLength(0)
    expect(await count('bid.requested')).toBe(0)
    expect((await db.transaction((tx) => recordBid(tx, bid('a')))).created).toBe(true)
  })

  it('FR-LEAD-4: an order recorded before the router (no route row) is bid on as ever', async () => {
    expect((await db.transaction((tx) => recordBid(tx, bid('hance-marketing')))).created).toBe(true)
  })
})

describe('pressing «Откликнуться»', () => {
  const notifier: Notifier = {
    sendLeadCard: async () => ({ messageId: 1 }),
    sendText: async () => ({ messageId: 2 }),
    sendButtons: async () => ({ messageId: 3 }),
  }
  let pipeline: LeadPipeline
  beforeEach(async () => {
    pipeline = createLeadPipeline({
      db,
      gateway: {} as Gateway,
      notifier,
      profi: { sessionHealth: async () => ({ alive: true, balance_rub: 5000 }) } as never,
      remindAfterMs: async () => 3_600_000,
    })
    await setSetting(db, 'outbound.bids', true, 'boris')
  })

  async function openLead(accountId: string): Promise<string> {
    await db.insert(lead).values({
      id: '7001',
      accountId,
      title: 'Сайт',
      category: 'Сайты',
      city: 'Краснодар',
      text: 'Нужен сайт',
      clientName: 'Ирина',
      bidPriceRub: 210,
      seenAt: new Date().toISOString(),
      status: 'queued',
      correlationId: newEventId(),
      draftText: 'Ирина, добрый день!\n\nПонимаю задачу.',
      draftPriceRub: 90000,
    })
    await db.insert(leadScore).values({
      id: newEventId(),
      leadId: '7001',
      version: 1,
      score: 68,
      decision: 'show',
      stopFactor: null,
      redFlags: [],
      axes: [],
      reason: 'r',
      confidence: 0.9,
      model: 'haiku',
    })
    const taskId = newEventId()
    await db.insert(task).values({
      id: taskId,
      kind: 'lead_decision',
      entityKind: 'lead',
      entityId: '7001',
      state: 'open',
    })
    return taskId
  }

  it('FR-LEAD-4: for an account that lost the route it answers so, leaves the task open and writes no bid', async () => {
    const taskId = await openLead('b')
    await route('7001', 'a')
    const answer = await pipeline.onPress({ taskId, action: 'bid' })
    expect(answer).toBe(TEXTS.lostRoute)
    expect(answer).toBe('Эта заявка досталась другому направлению')
    expect((await db.select().from(task).where(eq(task.id, taskId)))[0]?.state).toBe('open')
    expect(await db.select().from(outbox)).toHaveLength(0)
    expect(await count('task.resolved')).toBe(0)
  })

  it('FR-LEAD-4: the guard in the same transaction rolls the decision back too', async () => {
    // The route appears between the first look and the decision: recordBid refuses, the task is not resolved.
    const taskId = await openLead('b')
    await route('7001', 'a')
    await db.execute(sql`select 1`)
    const r = await db
      .transaction(async (tx) => {
        await tx.update(task).set({ state: 'resolved' }).where(eq(task.id, taskId))
        const bid2 = await recordBid(tx, bid('b'))
        if (bid2.outboxId === null) tx.rollback()
        return bid2
      })
      .catch(() => null)
    expect(r).toBeNull()
    expect((await db.select().from(task).where(eq(task.id, taskId)))[0]?.state).toBe('open')
  })
})
