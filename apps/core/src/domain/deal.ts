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
