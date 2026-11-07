import { and, eq, gt, inArray, notInArray, or, type SQL, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { lead, task } from '../db/schema'

/**
 * One rule for the bot and the pult (Boris, 30.10: «синхронны с ботом абсолютно»). A lead's task waits for Boris
 * while it is open, its order is neither closed on Profi.ru nor answered, and the order or the task is under a day
 * old (FR-LEAD-10: an older order is not offered; a held or borderline order counts from the summary that offered
 * it, as «Показать» always did). The Inbox, the queue, «Сегодня», the bot's /status and /queue read this rule; the
 * stale cards' pass (leads/staleCards.ts) closes the old ones and folds their cards, so nothing old waits anywhere.
 */

export const LEAD_TASK_KINDS = ['lead_decision', 'lead_held', 'lead_review'] as const
/** The order is over for us: closed on the site, answered, skipped, or aged out. */
const GONE = ['closed', 'bid_sent', 'skipped', 'stale']
export const WAIT_MS = 24 * 3600_000

export type WaitEnd = 'stale' | 'gone'

/** Why this open lead task no longer waits (null: it still does). */
export function waitEnd(
  t: { createdAt: string },
  l: { status: string; seenAt: string },
  now: Date,
): WaitEnd | null {
  if (GONE.includes(l.status)) return 'gone'
  const since = now.getTime() - WAIT_MS
  return Date.parse(l.seenAt) > since || Date.parse(t.createdAt) > since ? null : 'stale'
}

/** The same rule in SQL over `task` joined with `lead`: an open lead task that still waits for Boris. */
export function leadTaskWaits(now: Date): SQL {
  const since = new Date(now.getTime() - WAIT_MS).toISOString()
  return and(
    eq(task.state, 'open'),
    inArray(task.kind, [...LEAD_TASK_KINDS]),
    notInArray(lead.status, GONE),
    or(gt(lead.seenAt, since), gt(task.createdAt, since)),
  ) as SQL
}

/** How many tasks of each kind wait for Boris now: the numbers the bot and the pult both say. */
export async function waitingCounts(
  db: DbOrTx,
  now = new Date(),
): Promise<Record<(typeof LEAD_TASK_KINDS)[number], number>> {
  const rows = await db
    .select({ kind: task.kind, n: sql<number>`count(*)::int` })
    .from(task)
    .innerJoin(lead, eq(lead.id, task.entityId))
    .where(leadTaskWaits(now))
    .groupBy(task.kind)
  const of = (k: string) => rows.find((r) => r.kind === k)?.n ?? 0
  return {
    lead_decision: of('lead_decision'),
    lead_held: of('lead_held'),
    lead_review: of('lead_review'),
  }
}

/** Cards the stale cards' pass folded since `since` (lead.stale via card): the one line of the evening summary. */
export async function staleCardsSince(db: DbOrTx, since: Date): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from core.event
    where type = 'lead.stale' and payload->>'via' = 'card'
      and occurred_at > ${since.toISOString()}::timestamptz`)
  return r.rows[0]?.n ?? 0
}
