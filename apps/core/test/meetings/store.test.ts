import { newEventId } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deal, event, lead, meeting } from '../../src/db/schema'
import { advanceDeal, createDeal, dealPath, TransitionError } from '../../src/domain/deal'
import { createMeeting, ensureDeal, moveMeeting } from '../../src/meetings/store'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const correlationId = newEventId()
const ACC = 'hance-marketing'

async function seedLead(id = '95147898') {
  await db.insert(lead).values({
    id,
    accountId: ACC,
    title: 'Сайт',
    category: 'Маркетинг',
    city: 'Краснодар',
    text: 'Нужен сайт',
    clientName: 'Анна',
    bidPriceRub: 150,
    seenAt: new Date().toISOString(),
    correlationId,
  })
}

async function stageOf(id: string) {
  const [row] = await db.select({ stage: deal.stage }).from(deal).where(eq(deal.id, id))
  return row?.stage
}

async function bidDeal() {
  await seedLead()
  return createDeal(db, { leadId: '95147898', accountId: ACC, correlationId })
}

describe('deal paths', () => {
  it('FR-MEET-4: dealPath finds the shortest allowed path', () => {
    expect(dealPath('bid_sent', 'call_booked')).toEqual(['talking', 'call_booked'])
    expect(dealPath('lost', 'won')).toEqual(['talking', 'won'])
    expect(dealPath('call_done', 'call_done')).toEqual([])
    expect(dealPath('won', 'found')).toBeNull()
  })

  it('FR-MEET-4: advanceDeal walks bid_sent to call_booked through talking and journals each step', async () => {
    const id = await bidDeal()
    const steps = await advanceDeal(db, {
      dealId: id,
      to: 'call_booked',
      actor: 'boris',
      reason: null,
      correlationId,
    })
    expect(steps).toEqual(['talking', 'call_booked'])
    expect(await stageOf(id)).toBe('call_booked')
    expect(await countEvents(db, 'deal.stage_changed', id)).toBe(3)
  })

  it('FR-MEET-4: a stage with no path is refused and nothing changes', async () => {
    const id = await bidDeal()
    await expect(
      advanceDeal(db, { dealId: id, to: 'found', actor: 'boris', reason: null, correlationId }),
    ).rejects.toBeInstanceOf(TransitionError)
    expect(await stageOf(id)).toBe('bid_sent')
    expect(await countEvents(db, 'deal.stage_changed', id)).toBe(1)
  })

  it('FR-MEET-4: only Boris moves a deal out of won or lost', async () => {
    const id = await bidDeal()
    await advanceDeal(db, { dealId: id, to: 'lost', actor: 'boris', reason: null, correlationId })
    await expect(
      advanceDeal(db, { dealId: id, to: 'talking', actor: 'sara', reason: null, correlationId }),
    ).rejects.toBeInstanceOf(TransitionError)
    expect(await stageOf(id)).toBe('lost')
  })

  it('FR-MEET-4: Отказ corrected to Договор walks the shortest path lost, talking, won', async () => {
    const id = await bidDeal()
    await advanceDeal(db, { dealId: id, to: 'lost', actor: 'boris', reason: null, correlationId })
    const steps = await advanceDeal(db, {
      dealId: id,
      to: 'won',
      actor: 'boris',
      reason: null,
      correlationId,
    })
    expect(steps).toEqual(['talking', 'won'])
    expect(await stageOf(id)).toBe('won')
  })
})

describe('meeting states', () => {
  async function newMeeting(
    dealId: string,
    state: 'offered' | 'booked',
    phone: string | null = null,
  ) {
    return db.transaction((tx) =>
      createMeeting(tx, {
        dealId,
        conversationId: null,
        accountId: ACC,
        kind: state === 'offered' ? 'sara' : 'boris',
        state,
        startsAt: state === 'booked' ? '2026-10-30T12:00:00.000Z' : null,
        durationMin: 30,
        channel: 'phone',
        offered: state === 'offered' ? ['2026-10-30T12:00:00.000Z'] : null,
        roundKey: null,
        createdBy: state === 'offered' ? 'sara' : 'boris',
        phone,
      }),
    )
  }

  it('FR-MEET-2: a meeting cannot go from offered to done', async () => {
    const id = await bidDeal()
    const m = await newMeeting(id, 'offered')
    await expect(db.transaction((tx) => moveMeeting(tx, m, 'done', {}, 'boris'))).rejects.toThrow(
      /offered -> done/,
    )
    const [row] = await db.select().from(meeting).where(eq(meeting.id, m))
    expect(row?.state).toBe('offered')
  })

  it('FR-MEET-2: each move writes its own event', async () => {
    const id = await bidDeal()
    const m = await newMeeting(id, 'offered')
    await db.transaction((tx) =>
      moveMeeting(tx, m, 'confirming', { startsAt: '2026-10-30T12:00:00.000Z' }, 'sara'),
    )
    await db.transaction((tx) => moveMeeting(tx, m, 'offered', { startsAt: null }, 'sara'))
    await db.transaction((tx) =>
      moveMeeting(tx, m, 'confirming', { startsAt: '2026-10-30T12:00:00.000Z' }, 'sara'),
    )
    await db.transaction((tx) => moveMeeting(tx, m, 'booked', {}, 'sara'))
    await db.transaction((tx) => moveMeeting(tx, m, 'done', {}, 'boris'))
    await db.transaction((tx) => moveMeeting(tx, m, 'no_show', {}, 'boris'))
    for (const [t, n] of [
      ['meeting.offered', 1],
      ['meeting.confirming', 2],
      ['meeting.unconfirmed', 1],
      ['meeting.booked', 1],
      ['meeting.held', 1],
      ['meeting.no_show', 1],
    ] as const)
      expect(await countEvents(db, t, m)).toBe(n)
  })

  it('FR-MEET-2: events carry no phone', async () => {
    const id = await bidDeal()
    const m = await newMeeting(id, 'booked', '+7 918 123-45-67')
    await db.transaction((tx) => moveMeeting(tx, m, 'cancelled', { cancelledBy: 'boris' }, 'boris'))
    const rows = await db.select().from(event).where(eq(event.entityId, m))
    expect(rows.length).toBe(2)
    for (const r of rows) expect(JSON.stringify(r.payload)).not.toMatch(/918|123-45/)
    const [row] = await db.select().from(meeting).where(eq(meeting.id, m))
    expect(row?.phonePurgeAt).not.toBeNull()
  })
})

describe('ensureDeal', () => {
  it('FR-MEET-4: ensureDeal finds the deal made by a bid and makes no second one', async () => {
    const id = await bidDeal()
    const r = await ensureDeal(db, { accountId: ACC, orderId: '95147898', actor: 'boris' })
    expect(r).toEqual({ dealId: id, created: false })
    expect(await db.select().from(deal)).toHaveLength(1)
  })

  it('FR-MEET-4: ensureDeal for a v1 client makes one deal even when called twice at once', async () => {
    const [a, b] = await Promise.all([
      ensureDeal(db, { accountId: ACC, orderId: '90000001', actor: 'boris' }),
      ensureDeal(db, { accountId: ACC, orderId: '90000001', actor: 'boris' }),
    ])
    expect(a.dealId).toBe(b.dealId)
    expect([a.created, b.created].sort()).toEqual([false, true])
    const rows = await db.select().from(deal)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      origin: 'v1',
      stage: 'talking',
      leadId: null,
      orderId: '90000001',
    })
    expect(await countEvents(db, 'deal.stage_changed', a.dealId)).toBe(1)
  })

  it('FR-MEET-4: ensureDeal links the lead when the order is known and leaves it empty when not', async () => {
    await seedLead('90000005')
    const known = await ensureDeal(db, { accountId: ACC, orderId: '90000005', actor: 'boris' })
    const unknown = await ensureDeal(db, { accountId: ACC, orderId: '90000006', actor: 'boris' })
    const [k] = await db.select().from(deal).where(eq(deal.id, known.dealId))
    const [u] = await db
      .select()
      .from(deal)
      .where(and(eq(deal.id, unknown.dealId)))
    expect(k).toMatchObject({ leadId: '90000005', origin: 'v1' })
    expect(u?.leadId).toBeNull()
  })
})
