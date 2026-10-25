import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, lead, leadCandidate, leadRoute } from '../../src/db/schema'
import { saveProfile, seedProfile } from '../../src/direction/profile'
import {
  type Candidate,
  chooseDirection,
  decideRoute,
  lostRoute,
  recordCandidate,
  routeOf,
  routeOrder,
} from '../../src/direction/router'
import { seedDirection } from '../../src/direction/store'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const c = (accountId: string, over: Partial<Candidate> = {}): Candidate => ({
  accountId,
  state: 'on',
  decision: 'show',
  margin: 10,
  ...over,
})

describe('chooseDirection', () => {
  it('FR-LEAD-4: nobody fits, nobody gets the order', () => {
    expect(chooseDirection([])).toEqual({ winner: null, alternatives: [], needsChoice: false })
    expect(
      chooseDirection([c('a', { decision: 'drop', margin: -5 }), c('b', { decision: 'drop' })]),
    ).toEqual({ winner: null, alternatives: [], needsChoice: false })
  })

  it('FR-LEAD-4: one fitting direction gets it whatever the others scored', () => {
    expect(
      chooseDirection([c('a', { margin: 2 }), c('b', { decision: 'drop', margin: 40 })]),
    ).toEqual({ winner: 'a', alternatives: [], needsChoice: false })
  })

  it("FR-LEAD-4: two fit, the bigger margin over its own threshold wins and the other needs Boris's choice", () => {
    expect(chooseDirection([c('a', { margin: 5 }), c('b', { margin: 12 })])).toEqual({
      winner: 'b',
      alternatives: ['a'],
      needsChoice: true,
    })
  })

  it('FR-LEAD-4: equal margins go to the smaller account id', () => {
    expect(chooseDirection([c('b', { margin: 7 }), c('a', { margin: 7 })]).winner).toBe('a')
  })

  it('FR-LEAD-4: a direction in shadow or draft never wins', () => {
    expect(
      chooseDirection([c('a', { state: 'shadow', margin: 50 }), c('b', { state: 'draft' })]),
    ).toEqual({ winner: null, alternatives: [], needsChoice: false })
    expect(
      chooseDirection([c('a', { state: 'shadow', margin: 50 }), c('b', { margin: 1 })]),
    ).toEqual({ winner: 'b', alternatives: [], needsChoice: false })
  })

  it('FR-LEAD-4: an unscored order goes to its own account when nobody else fits', () => {
    expect(chooseDirection([c('a', { decision: 'unscored', margin: null })]).winner).toBe('a')
    expect(
      chooseDirection([
        c('a', { decision: 'unscored', margin: null }),
        c('b', { decision: 'drop' }),
      ]).winner,
    ).toBe('a')
    // A direction that judged it and found it fitting comes first.
    expect(
      chooseDirection([c('a', { decision: 'unscored', margin: null }), c('b', { margin: 1 })])
        .winner,
    ).toBe('b')
    // Two unscored ones: the smaller id, and Boris is to choose.
    expect(
      chooseDirection([
        c('b', { decision: 'unscored', margin: null }),
        c('a', { decision: 'unscored', margin: null }),
      ]),
    ).toEqual({ winner: 'a', alternatives: ['b'], needsChoice: true })
  })
})

describe('the route of an order', () => {
  beforeEach(async () => {
    await resetDb(db)
    await seedDirection(db, 'hance-marketing')
    await seedProfile(db, 'hance-marketing')
    await saveProfile(db, 'other', { state: 'on' }, 'boris')
  })
  const vote = (orderId: string, accountId: string, margin: number | null, decision = 'show') =>
    recordCandidate(db, orderId, {
      accountId,
      score: 60,
      decision: decision as 'show',
      stopFactor: null,
      margin,
    })

  it('FR-LEAD-4: the bigger margin wins the route, which is written once with an event', async () => {
    await vote('o1', 'hance-marketing', 4)
    await vote('o1', 'other', 9)
    const r = await decideRoute(db, 'o1', newEventId())
    expect(r).toEqual({ winner: 'other', needsChoice: true })
    expect(await routeOf(db, 'o1')).toEqual(r)
    const [row] = await db.select().from(leadRoute).where(eq(leadRoute.orderId, 'o1'))
    expect(row).toMatchObject({
      state: 'routed',
      accountId: 'other',
      alternatives: ['hance-marketing'],
    })
    const events = await db.select().from(event).where(eq(event.type, 'lead.routed'))
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ winner: 'other', needs_choice: true })
  })

  it('FR-LEAD-4: a decided route is never reopened by a late candidate', async () => {
    await vote('o2', 'hance-marketing', 1)
    expect((await decideRoute(db, 'o2', newEventId())).winner).toBe('hance-marketing')
    await vote('o2', 'other', 99)
    expect((await decideRoute(db, 'o2', newEventId())).winner).toBe('hance-marketing')
    expect(
      await db.select().from(leadCandidate).where(eq(leadCandidate.orderId, 'o2')),
    ).toHaveLength(2)
    expect(await db.select().from(event).where(eq(event.type, 'lead.routed'))).toHaveLength(1)
  })

  it('FR-LEAD-4: two decideRoute calls at once give one route', async () => {
    await vote('o3', 'hance-marketing', 3)
    const results = await Promise.all(
      Array.from({ length: 5 }, () => decideRoute(db, 'o3', newEventId())),
    )
    expect(new Set(results.map((r) => r.winner))).toEqual(new Set(['hance-marketing']))
    expect(await db.select().from(leadRoute).where(eq(leadRoute.orderId, 'o3'))).toHaveLength(1)
    expect(await db.select().from(event).where(eq(event.type, 'lead.routed'))).toHaveLength(1)
  })

  it('FR-LEAD-4: the same direction voting again replaces its vote', async () => {
    await vote('o4', 'hance-marketing', 1)
    await vote('o4', 'hance-marketing', 8, 'drop')
    const rows = await db.select().from(leadCandidate).where(eq(leadCandidate.orderId, 'o4'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ margin: 8, decision: 'drop' })
  })

  it('FR-LEAD-4: an order nobody won is nobody’s loss: its own account can still be asked to bid after all', async () => {
    await vote('o6', 'hance-marketing', 5, 'drop')
    expect(await decideRoute(db, 'o6', newEventId())).toEqual({ winner: null, needsChoice: false })
    expect(await lostRoute(db, 'o6', 'hance-marketing')).toBe(false)
  })

  it('FR-LEAD-4: no route means nobody lost; a route for another account means this one did', async () => {
    expect(await lostRoute(db, 'o5', 'hance-marketing')).toBe(false)
    await vote('o5', 'other', 5)
    await decideRoute(db, 'o5', newEventId())
    expect(await lostRoute(db, 'o5', 'hance-marketing')).toBe(true)
    expect(await lostRoute(db, 'o5', 'other')).toBe(false)
  })
})

describe('routeOrder, the pipeline door', () => {
  beforeEach(async () => {
    await resetDb(db)
    await seedDirection(db, 'hance-marketing')
    await seedProfile(db, 'hance-marketing')
  })
  const row = async (id: string) => {
    await db.insert(lead).values({
      id,
      accountId: 'hance-marketing',
      title: 't',
      category: 'c',
      city: 'г',
      text: 'x',
      clientName: '',
      bidPriceRub: 100,
      seenAt: new Date().toISOString(),
      correlationId: newEventId(),
    })
    return id
  }
  const scored = (score: number, decision: 'show' | 'drop') => ({
    score,
    decision,
    stopFactor: null,
    version: 1,
  })

  it('FR-LEAD-4: with one working direction the order is its own, as before', async () => {
    const id = await row('r1')
    const r = await routeOrder(db, {
      orderId: id,
      accountId: 'hance-marketing',
      correlationId: newEventId(),
      scored: scored(70, 'show'),
    })
    expect(r).toMatchObject({ winner: 'hance-marketing', mine: true })
    const [cand] = await db.select().from(leadCandidate).where(eq(leadCandidate.orderId, id))
    // The margin is over the threshold of the rules the order was scored under (56 in the seed).
    expect(cand).toMatchObject({ decision: 'show', score: 70, margin: 14 })
    expect((await db.select().from(lead).where(eq(lead.id, id)))[0]?.status).toBe('new')
  })

  it('FR-LEAD-4: a shown order of a direction in the shadow records its vote, gets no route and is marked unrouted', async () => {
    await saveProfile(db, 'hance-marketing', { state: 'shadow' }, 'boris')
    const id = await row('r2')
    const r = await routeOrder(db, {
      orderId: id,
      accountId: 'hance-marketing',
      correlationId: newEventId(),
      scored: scored(70, 'show'),
    })
    expect(r).toMatchObject({ winner: null, mine: false })
    expect((await db.select().from(lead).where(eq(lead.id, id)))[0]?.status).toBe('unrouted')
    expect(await db.select().from(leadCandidate).where(eq(leadCandidate.orderId, id))).toHaveLength(
      1,
    )
  })

  it('FR-LEAD-4: a dropped order keeps its vote and its own status, and an unscored one still gets its card', async () => {
    const dropped = await row('r3')
    await db.update(lead).set({ status: 'scored_out' }).where(eq(lead.id, dropped))
    const d = await routeOrder(db, {
      orderId: dropped,
      accountId: 'hance-marketing',
      correlationId: newEventId(),
      scored: scored(30, 'drop'),
    })
    expect(d.mine).toBe(false)
    expect((await db.select().from(lead).where(eq(lead.id, dropped)))[0]?.status).toBe('scored_out')
    const unscored = await row('r4')
    const u = await routeOrder(db, {
      orderId: unscored,
      accountId: 'hance-marketing',
      correlationId: newEventId(),
      scored: null,
    })
    expect(u).toMatchObject({ winner: 'hance-marketing', mine: true })
    const [cand] = await db.select().from(leadCandidate).where(eq(leadCandidate.orderId, unscored))
    expect(cand).toMatchObject({ decision: 'unscored', score: null, margin: null })
  })

  it('FR-LEAD-4: repeating the step after a crash changes nothing', async () => {
    const id = await row('r5')
    const p = {
      orderId: id,
      accountId: 'hance-marketing',
      correlationId: newEventId(),
      scored: scored(70, 'show' as const),
    }
    await routeOrder(db, p)
    await routeOrder(db, p)
    expect(await db.select().from(leadRoute).where(eq(leadRoute.orderId, id))).toHaveLength(1)
    expect(await db.select().from(event).where(eq(event.type, 'lead.routed'))).toHaveLength(1)
  })
})
