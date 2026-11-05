import { type Actor, newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
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
  talking: ['call_proposed', 'won', 'lost', 'dormant'],
  call_proposed: ['call_booked', 'talking', 'lost', 'dormant'],
  call_booked: ['call_done', 'call_proposed', 'lost'],
  call_done: ['won', 'lost', 'talking'],
  dormant: ['talking', 'lost'],
  won: [],
  lost: [],
}

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
  await db.insert(deal).values({ id, leadId: i.leadId, accountId: i.accountId, stage: 'bid_sent' })
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
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(deal).where(eq(deal.id, i.dealId)).for('update')
    if (!row) throw new Error(`deal ${i.dealId} not found`)
    const from = row.stage as DealStage
    if (!ALLOWED_TRANSITIONS[from]?.includes(i.to)) throw new TransitionError(from, i.to)
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
  })
}

/** The shortest chain of allowed steps from one stage to another (the stages it passes included), or null. */
export function pathBetween(from: DealStage, to: DealStage): DealStage[] | null {
  if (from === to) return []
  const prev = new Map<DealStage, DealStage>()
  const queue: DealStage[] = [from]
  while (queue.length > 0) {
    const at = queue.shift() as DealStage
    for (const next of ALLOWED_TRANSITIONS[at]) {
      if (next === from || prev.has(next)) continue
      prev.set(next, at)
      if (next === to) {
        const path: DealStage[] = [to]
        for (let k = at; k !== from; k = prev.get(k) as DealStage) path.unshift(k)
        return path
      }
      queue.push(next)
    }
  }
  return null
}

/**
 * Moves a deal to a stage along the allowed steps, each one journaled (Boris, 01.11: the stage moves by itself, on
 * the events, and every reader of it, the topic, the sheet, the pult and the analytics, sees the same one). A deal
 * already there, or further on than any way back to it, stays; returns whether it moved.
 */
export async function advanceTo(
  db: Db,
  i: { dealId: string; to: DealStage; actor: Actor; reason: string | null; correlationId: string },
): Promise<boolean> {
  const [row] = await db.select({ stage: deal.stage }).from(deal).where(eq(deal.id, i.dealId))
  if (!row) return false
  const path = pathBetween(row.stage as DealStage, i.to)
  if (!path || path.length === 0) return false
  for (const to of path) {
    try {
      await transition(db, { ...i, to })
    } catch (e) {
      // Moved by someone else meanwhile: what is there is right.
      if (e instanceof TransitionError) return false
      throw e
    }
  }
  return true
}
