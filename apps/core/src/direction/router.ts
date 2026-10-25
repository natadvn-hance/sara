import { DirectionRules, type DirectionState } from '@sara/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { directionVersion, lead, leadCandidate, leadRoute } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { getProfile } from './profile'

export type CandidateDecision = 'show' | 'drop' | 'unscored'

/** One direction's vote on an order, with the state it is in now. */
export type Candidate = {
  accountId: string
  state: DirectionState
  decision: CandidateDecision
  margin: number | null
}

export type Choice = { winner: string | null; alternatives: string[]; needsChoice: boolean }

const NONE: Choice = { winner: null, alternatives: [], needsChoice: false }
const LOWEST = Number.MIN_SAFE_INTEGER

/**
 * Which direction gets the order (FR-LEAD-4). Only directions that work (`on`) can win: one that is a draft or in
 * the shadow votes but never wins. Among those that fit (the Scorer said «show») the bigger margin over its own
 * threshold wins, the smaller account id on a tie; the others are alternatives and Boris is to choose (the card
 * for that choice is M8, until then the winner's card goes out). When none fits, an order the Scorer could not
 * judge goes to a working direction that has it unscored, so a model failure does not lose an order.
 */
export function chooseDirection(candidates: Candidate[]): Choice {
  const working = candidates.filter((c) => c.state === 'on')
  const fits = working.filter((c) => c.decision === 'show')
  const pool = fits.length > 0 ? fits : working.filter((c) => c.decision === 'unscored')
  if (pool.length === 0) return NONE
  const [winner, ...rest] = [...pool].sort(
    (a, b) => (b.margin ?? LOWEST) - (a.margin ?? LOWEST) || (a.accountId < b.accountId ? -1 : 1),
  )
  return {
    winner: winner?.accountId ?? null,
    alternatives: rest.map((c) => c.accountId),
    needsChoice: rest.length > 0,
  }
}

/** A direction's vote; a repeat of the same direction replaces the earlier vote. */
export async function recordCandidate(
  tx: DbOrTx,
  orderId: string,
  c: {
    accountId: string
    score: number | null
    decision: CandidateDecision
    stopFactor: string | null
    margin: number | null
  },
): Promise<void> {
  const row = {
    orderId,
    accountId: c.accountId,
    score: c.score,
    decision: c.decision,
    stopFactor: c.stopFactor,
    margin: c.margin,
  }
  await tx
    .insert(leadCandidate)
    .values(row)
    .onConflictDoUpdate({
      target: [leadCandidate.orderId, leadCandidate.accountId],
      set: {
        score: row.score,
        decision: row.decision,
        stopFactor: row.stopFactor,
        margin: row.margin,
      },
    })
}

export type RouteResult = { winner: string | null; needsChoice: boolean }

/** The route of an order, if it has been decided. */
export async function routeOf(db: DbOrTx, orderId: string): Promise<RouteResult | null> {
  const [r] = await db.select().from(leadRoute).where(eq(leadRoute.orderId, orderId))
  return r ? { winner: r.accountId, needsChoice: r.needsChoice } : null
}

/**
 * Decides the route once, from the votes there are now, under a lock on the order: two callers at once get the
 * same answer, and a vote that comes later never reopens it. The journal gets `lead.routed`.
 */
export async function decideRoute(
  db: Db,
  orderId: string,
  correlationId: string,
): Promise<RouteResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`route:${orderId}`}))`)
    const done = await routeOf(tx, orderId)
    if (done) return done
    const votes = await tx.select().from(leadCandidate).where(eq(leadCandidate.orderId, orderId))
    const candidates: Candidate[] = []
    for (const v of votes)
      candidates.push({
        accountId: v.accountId,
        state: (await getProfile(tx, v.accountId)).state,
        decision: v.decision as CandidateDecision,
        margin: v.margin,
      })
    const choice = chooseDirection(candidates)
    await tx.insert(leadRoute).values({
      orderId,
      accountId: choice.winner,
      state: choice.winner ? 'routed' : 'none',
      needsChoice: choice.needsChoice,
      alternatives: choice.alternatives,
    })
    await appendEvent(tx, {
      type: 'lead.routed',
      v: 1,
      entity: { kind: 'lead', id: orderId },
      account_id: choice.winner,
      actor: 'sara',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: correlationId,
      reason: null,
      payload: {
        winner: choice.winner,
        alternatives: choice.alternatives,
        needs_choice: choice.needsChoice,
        candidates: candidates.length,
      },
    })
    return { winner: choice.winner, needsChoice: choice.needsChoice }
  })
}

/** The threshold of the rules the order was scored under (the version, not whatever is active now). */
async function thresholdOf(db: DbOrTx, accountId: string, version: number): Promise<number | null> {
  const [v] = await db
    .select({ rules: directionVersion.rules })
    .from(directionVersion)
    .where(and(eq(directionVersion.accountId, accountId), eq(directionVersion.version, version)))
  return v ? DirectionRules.parse(v.rules).threshold : null
}

export type Scoring = {
  score: number
  decision: 'show' | 'drop'
  stopFactor: string | null
  version: number
}

/**
 * The pipeline's door to the router: this direction's vote on the order (an order the Scorer could not judge votes
 * `unscored`), then the route. An order that a working direction lost, or that nobody got although it was worth a
 * card, is marked `unrouted` so nothing else treats it as waiting. Safe to repeat.
 */
export async function routeOrder(
  db: Db,
  p: { orderId: string; accountId: string; correlationId: string; scored: Scoring | null },
): Promise<RouteResult & { mine: boolean }> {
  const { scored } = p
  const threshold = scored ? await thresholdOf(db, p.accountId, scored.version) : null
  await recordCandidate(db, p.orderId, {
    accountId: p.accountId,
    score: scored?.score ?? null,
    decision: scored ? scored.decision : 'unscored',
    stopFactor: scored?.stopFactor ?? null,
    margin: scored && threshold !== null ? scored.score - threshold : null,
  })
  const route = await decideRoute(db, p.orderId, p.correlationId)
  const mine = route.winner === p.accountId
  if (!mine && scored?.decision !== 'drop')
    await db
      .update(lead)
      .set({ status: 'unrouted' })
      .where(and(eq(lead.id, p.orderId), eq(lead.status, 'new')))
  return { ...route, mine }
}

/** True when the order has a route and this account is not its winner: nothing of the order is this account's to do. */
export async function lostRoute(db: DbOrTx, orderId: string, accountId: string): Promise<boolean> {
  const route = await routeOf(db, orderId)
  return route !== null && route.winner !== accountId
}
