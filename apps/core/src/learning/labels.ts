import { DirectionRules, newEventId } from '@sara/shared'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { directionVersion, lead, leadLabel, leadScore, task } from '../db/schema'
import { appendEvent } from '../journal/journal'

export type Label = 'yes' | 'no' | 'weak_no'
export type LabelSource = 'card' | 'summary' | 'ignored' | 'pult'

/** A skip this far above the threshold surprises Sara enough to ask why. */
export const SURPRISE_ABOVE = 15
const IGNORED_AFTER_MS = 24 * 3600_000

/**
 * Boris's decision as an example for the rules (one per lead, the first one counts). A surprise is a skip of a
 * card scored at least SURPRISE_ABOVE over the threshold, or «Взял бы» on an order Sara dropped.
 */
export async function recordLabel(
  db: Db,
  l: { leadId: string; label: Label; source: LabelSource; reason?: string | null },
): Promise<{ created: boolean; surprise: boolean }> {
  return db.transaction(async (tx) => {
    const [sc] = await tx
      .select({ score: leadScore.score, version: leadScore.version, accountId: lead.accountId })
      .from(leadScore)
      .innerJoin(lead, eq(lead.id, leadScore.leadId))
      .where(and(eq(leadScore.leadId, l.leadId), eq(leadScore.backtest, false)))
      .orderBy(desc(leadScore.createdAt))
      .limit(1)
    let surprise = l.label === 'yes' && l.source === 'summary'
    if (sc && l.label === 'no' && (l.source === 'card' || l.source === 'pult')) {
      const [v] = await tx
        .select({ rules: directionVersion.rules })
        .from(directionVersion)
        .where(
          and(
            eq(directionVersion.accountId, sc.accountId),
            eq(directionVersion.version, sc.version),
          ),
        )
      if (v) surprise = sc.score >= DirectionRules.parse(v.rules).threshold + SURPRISE_ABOVE
    }
    const rows = await tx
      .insert(leadLabel)
      .values({
        leadId: l.leadId,
        label: l.label,
        source: l.source,
        reason: l.reason ?? null,
        score: sc?.score ?? null,
        scoreVersion: sc?.version ?? null,
        surprise,
      })
      .onConflictDoNothing()
      .returning({ id: leadLabel.leadId })
    if (rows.length === 0) return { created: false, surprise: false }
    const [ld] = await tx
      .select({ correlationId: lead.correlationId, accountId: lead.accountId })
      .from(lead)
      .where(eq(lead.id, l.leadId))
    await appendEvent(tx, {
      type: 'lead.labeled',
      v: 1,
      entity: { kind: 'lead', id: l.leadId },
      account_id: ld?.accountId ?? null,
      actor: l.source === 'ignored' ? 'system' : 'boris',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: ld?.correlationId ?? newEventId(),
      reason: null,
      payload: { label: l.label, source: l.source, surprise },
    })
    return { created: true, surprise }
  })
}

/** Cards nobody pressed for 24 hours count as a weak no, without a question. */
export async function sweepIgnored(db: Db, now: Date): Promise<number> {
  const before = new Date(now.getTime() - IGNORED_AFTER_MS).toISOString()
  const stale = await db
    .select({ leadId: task.entityId })
    .from(task)
    .leftJoin(leadLabel, eq(leadLabel.leadId, task.entityId))
    .where(
      and(
        eq(task.kind, 'lead_decision'),
        eq(task.state, 'open'),
        lt(task.createdAt, before),
        sql`${leadLabel.leadId} is null`,
      ),
    )
  let n = 0
  for (const s of stale) {
    if ((await recordLabel(db, { leadId: s.leadId, label: 'weak_no', source: 'ignored' })).created)
      n++
  }
  return n
}
