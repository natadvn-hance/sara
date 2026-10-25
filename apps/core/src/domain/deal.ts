import { type Actor, newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { Db, DbOrTx, Tx } from '../db/client'
import { deal } from '../db/schema'
import * as journal from '../journal/journal'

export const DEAL_STAGES = [
  'found',
  'queued',
  'bid_sent',
  'talking',
  'call_proposed',
  'call_booked',
  'call_done',
  'won',
  'lost',
  'dormant',
] as const
export type DealStage = (typeof DEAL_STAGES)[number]

export const ALLOWED_TRANSITIONS: Record<DealStage, readonly DealStage[]> = {
  found: ['queued', 'lost'],
  queued: ['bid_sent', 'lost'],
  bid_sent: ['talking', 'lost', 'dormant'],
  // M6: Boris marks a meeting without Sara's offer; a cancel or a no-show; a second call after the first.
  talking: ['call_proposed', 'call_booked', 'won', 'lost', 'dormant'],
  call_proposed: ['call_booked', 'talking', 'lost', 'dormant'],
  call_booked: ['call_done', 'call_proposed', 'talking', 'lost'],
  call_done: ['won', 'lost', 'talking', 'call_proposed', 'call_booked'],
  dormant: ['talking', 'lost'],
  // M6 corrections, Boris's only (CORRECTION_FROM): «Договор» pressed by mistake; a refused or closed client reopened.
  won: ['call_done'],
  lost: ['talking'],
}

/** Stages only Boris may move a deal out of: their way out is a correction of his own outcome. */
export const CORRECTION_FROM: readonly DealStage[] = ['won', 'lost']

export class TransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: DealStage,
  ) {
    super(`transition ${from} -> ${to} is not allowed`)
  }
}

export async function createDeal(
  db: DbOrTx,
  i: { leadId: string; accountId: string; correlationId: string },
): Promise<string> {
  const id = newEventId()
  await db
    .insert(deal)
    .values({ id, leadId: i.leadId, orderId: i.leadId, accountId: i.accountId, stage: 'bid_sent' })
  await journal.appendEvent(db, {
    type: 'deal.stage_changed',
    v: 1,
    entity: { kind: 'deal', id },
    account_id: i.accountId,
    actor: 'sara',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: i.correlationId,
    reason: null,
    payload: { from: null, to: 'bid_sent' },
  })
  return id
}

/** The only way a deal changes stage: checked, written and journaled in one transaction. */
export async function transition(
  db: Db,
  i: { dealId: string; to: DealStage; actor: Actor; reason: string | null; correlationId: string },
): Promise<void> {
  await db.transaction((tx) => transitionTx(tx, i))
}

/** `transition` inside a transaction the caller holds. */
export async function transitionTx(
  tx: Tx,
  i: { dealId: string; to: DealStage; actor: Actor; reason: string | null; correlationId: string },
): Promise<void> {
  const [row] = await tx.select().from(deal).where(eq(deal.id, i.dealId)).for('update')
  if (!row) throw new Error(`deal ${i.dealId} not found`)
  const from = row.stage as DealStage
  if (!ALLOWED_TRANSITIONS[from]?.includes(i.to)) throw new TransitionError(from, i.to)
  if (CORRECTION_FROM.includes(from) && i.actor !== 'boris') throw new TransitionError(from, i.to)
  await tx
    .update(deal)
    .set({ stage: i.to, updatedAt: new Date().toISOString() })
    .where(eq(deal.id, i.dealId))
  await journal.appendEvent(tx, {
    type: 'deal.stage_changed',
    v: 1,
    entity: { kind: 'deal', id: i.dealId },
    account_id: row.accountId,
    actor: i.actor,
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: i.correlationId,
    reason: i.reason,
    payload: { from, to: i.to },
  })
}

/** The shortest way from one stage to another by allowed transitions, without `from`; null when there is none. */
export function dealPath(from: DealStage, to: DealStage): DealStage[] | null {
  if (from === to) return []
  const prev = new Map<DealStage, DealStage>([[from, from]])
  const queue: DealStage[] = [from]
  while (queue.length > 0) {
    const at = queue.shift() as DealStage
    for (const next of ALLOWED_TRANSITIONS[at]) {
      if (prev.has(next)) continue
      prev.set(next, at)
      if (next === to) {
        const path: DealStage[] = [to]
        for (let s = at; s !== from; s = prev.get(s) as DealStage) path.unshift(s)
        return path
      }
      // A final stage is never a stop on the way to another one: only a correction leaves it.
      if (!CORRECTION_FROM.includes(next)) queue.push(next)
    }
  }
  return null
}

/**
 * Moves a deal to `to` by the shortest allowed path, every step journaled, all in one transaction (M6: a client of
 * old Sara at talking goes talking, call_booked when Boris marks a meeting). No path: TransitionError, nothing changes.
 * Leaving won or lost needs `correction: true` (Boris correcting his own outcome), so a later meeting mark never
 * quietly un-wins a deal.
 */
export async function advanceDeal(
  db: DbOrTx,
  i: {
    dealId: string
    to: DealStage
    actor: Actor
    reason: string | null
    correlationId: string
    correction?: boolean
  },
): Promise<DealStage[]> {
  const { correction, ...step } = i
  const run = async (tx: Tx) => {
    const [row] = await tx
      .select({ stage: deal.stage })
      .from(deal)
      .where(eq(deal.id, i.dealId))
      .for('update')
    if (!row) throw new Error(`deal ${i.dealId} not found`)
    const from = row.stage as DealStage
    if (CORRECTION_FROM.includes(from) && from !== i.to && !correction)
      throw new TransitionError(from, i.to)
    const path = dealPath(from, i.to)
    if (path === null) throw new TransitionError(from, i.to)
    for (const to of path) await transitionTx(tx, { ...step, to })
    return path
  }
  // Inside a caller's transaction this is a savepoint: a refused step undoes only this walk.
  return (db as Db).transaction(run)
}
