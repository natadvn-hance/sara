import type { DirectionRules } from '@sara/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { lead, leadLabel, trialScore as trialTable } from '../db/schema'
import { NOT_TEST } from '../testLeads/sql'
import { getRun, type RunRow } from './runStore'
import { type TrialDeps, trialScore } from './trial'

/** How many of the latest leads a recompute looks at (FR-ACC-5). */
export const RECOMPUTE_SIZE = 50

/**
 * The leads a recompute tries the rules on: the account's latest ones that passed the Sorter and got a live
 * score (a trial score of an earlier proposal is not one), newest first.
 */
export async function recomputePool(
  db: Db,
  accountId: string,
  n = RECOMPUTE_SIZE,
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select l.id from core.lead l
    where l.account_id = ${accountId} and ${NOT_TEST('l.id')}
      and l.status not in ('sorted_out', 'stale')
      and exists (select 1 from core.lead_score s where s.lead_id = l.id and not s.backtest)
    order by l.seen_at desc, l.id desc
    limit ${n}`)
  return rows.rows.map((r) => r.id)
}

/** One lead of a recompute: scored under the old and the new rules on the same model. */
export async function recomputeProcess(
  d: TrialDeps,
  run: RunRow,
  leadId: string,
): Promise<'ok' | 'miss'> {
  const version = run.scorerVersion ?? undefined
  const base = await trialScore(d, leadId, run.baseRules as DirectionRules, 'plain', version)
  // Without the old score there is nothing to compare with: the new rules are not paid for.
  if (!base) return 'miss'
  const next = await trialScore(d, leadId, run.rules as DirectionRules, 'plain', version)
  return next ? 'ok' : 'miss'
}

type Side = { score: number; decision: 'show' | 'drop' }
export type RecomputeItem = {
  leadId: string
  title: string
  city: string
  before: Side
  after: Side & {
    reason: string
    stopFactor: string | null
    redFlags: string[]
    axes: { id: string; score: number; why: string }[]
  }
  boris: 'yes' | 'no' | null
}
export type RecomputeResult = {
  checked: number
  skipped: number
  changed: number
  toDrop: number
  toShow: number
  /** Leads of the run that carry a «yes» or «no» of Boris's. */
  withBoris: number
  agreementBefore: number | null
  agreementAfter: number | null
  items: RecomputeItem[]
}

/** What a finished (or running) recompute found: only leads with both scores count, the changed ones are listed. */
export async function recomputeResult(db: Db, runId: string): Promise<RecomputeResult> {
  const run = await getRun(db, runId)
  if (!run) throw new Error(`no run ${runId}`)
  const ids = run.leadIds as string[]
  const empty: RecomputeResult = {
    checked: 0,
    skipped: 0,
    changed: 0,
    toDrop: 0,
    toShow: 0,
    withBoris: 0,
    agreementBefore: null,
    agreementAfter: null,
    items: [],
  }
  if (ids.length === 0 || !run.baseHash) return empty
  const scores = await db
    .selectDistinctOn([trialTable.rulesHash, trialTable.leadId])
    .from(trialTable)
    .where(
      and(
        inArray(trialTable.rulesHash, [run.baseHash, run.rulesHash]),
        inArray(trialTable.leadId, ids),
        eq(trialTable.mode, 'plain'),
        // Only the scores of the prompt version this run used: an older prompt's are another judge's.
        ...(run.scorerVersion === null ? [] : [eq(trialTable.roleVersion, run.scorerVersion)]),
      ),
    )
    .orderBy(trialTable.rulesHash, trialTable.leadId, desc(trialTable.createdAt))
  const at = (hash: string, id: string) =>
    scores.find((s) => s.rulesHash === hash && s.leadId === id)
  const leads = await db.select().from(lead).where(inArray(lead.id, ids))
  const labels = await db.select().from(leadLabel).where(inArray(leadLabel.leadId, ids))
  const out = { ...empty }
  let beforeAgree = 0
  let afterAgree = 0
  for (const id of ids) {
    const b = at(run.baseHash, id)
    const a = at(run.rulesHash, id)
    if (!b || !a) continue
    out.checked++
    const label = labels.find((l) => l.leadId === id)?.label
    const boris = label === 'yes' ? 'yes' : label === 'no' ? 'no' : null
    if (boris) {
      out.withBoris++
      const wanted = boris === 'yes' ? 'show' : 'drop'
      if (b.decision === wanted) beforeAgree++
      if (a.decision === wanted) afterAgree++
    }
    if (a.decision === b.decision) continue
    out.changed++
    if (a.decision === 'drop') out.toDrop++
    else out.toShow++
    const l = leads.find((x) => x.id === id)
    out.items.push({
      leadId: id,
      title: l?.title ?? '',
      city: l?.city ?? '',
      before: { score: b.score, decision: b.decision === 'show' ? 'show' : 'drop' },
      after: {
        score: a.score,
        decision: a.decision === 'show' ? 'show' : 'drop',
        reason: a.reason,
        stopFactor: a.stopFactor,
        redFlags: a.redFlags as string[],
        axes: a.axes as { id: string; score: number; why: string }[],
      },
      boris,
    })
  }
  out.skipped = ids.length - out.checked
  if (out.withBoris > 0) {
    out.agreementBefore = beforeAgree / out.withBoris
    out.agreementAfter = afterAgree / out.withBoris
  }
  return out
}
