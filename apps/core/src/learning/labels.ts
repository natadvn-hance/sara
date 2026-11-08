import { DirectionRules, newEventId, thresholdFor } from '@sara/shared'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { directionVersion, event, lead, leadLabel, leadScore, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import {
  type ButtonCode,
  detailFor,
  type GuessInput,
  guessReason,
  isReasonCode,
  type Reason,
  type ReasonCode,
  rankReasons,
  reasonButtons,
  reasonFromWords,
} from './reasons'

export type Label = 'yes' | 'no' | 'weak_no'
export type LabelSource = 'card' | 'summary' | 'ignored' | 'pult'
export type ReasonBy = 'guess' | 'boris'

/** A skip this far above the threshold surprises Sara enough to ask why. */
export const SURPRISE_ABOVE = 15
const IGNORED_AFTER_MS = 24 * 3600_000

const clip = (s: string | null | undefined, n: number) => (s ? s.trim().slice(0, n) : null)

/** The lead, its live score, the Sorter's word and the threshold of its kind: what a decision is read against. */
async function contextOf(tx: DbOrTx, leadId: string) {
  const [row] = await tx
    .select({ l: lead, s: leadScore })
    .from(lead)
    .leftJoin(leadScore, and(eq(leadScore.leadId, lead.id), eq(leadScore.backtest, false)))
    .where(eq(lead.id, leadId))
    .orderBy(desc(leadScore.createdAt))
    .limit(1)
  if (!row) return null
  const [sorted] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.correlationId, row.l.correlationId), eq(event.type, 'lead.sorted')))
    .orderBy(desc(event.id))
    .limit(1)
  let threshold: number | null = null
  if (row.s) {
    const [v] = await tx
      .select({ rules: directionVersion.rules })
      .from(directionVersion)
      .where(
        and(
          eq(directionVersion.accountId, row.l.accountId),
          eq(directionVersion.version, row.s.version),
        ),
      )
    const rules = v ? DirectionRules.safeParse(v.rules) : null
    if (rules?.success) threshold = thresholdFor(rules.data, row.l.category)
  }
  return {
    l: row.l,
    s: row.s,
    sorted: (sorted?.payload ?? {}) as { verdict?: string | null; reason?: string | null },
    threshold,
  }
}
type Context = NonNullable<Awaited<ReturnType<typeof contextOf>>>

/**
 * What the rules need to guess, without asking, why Boris closed or took a card (31.10.2026): the score and what stood
 * behind it, the Sorter's word, the order's category, budget and fee, how long the card waited, and the Analyst's risk
 * and condition. No client name, no order text (ADR-016).
 */
function featuresOf(c: Context) {
  const an = (c.l.draftAnalysis ?? {}) as { risk?: string; condition?: string }
  return {
    category: c.l.category,
    city: c.l.city,
    budget_text: c.l.budgetText,
    fee_rub: c.l.bidPriceRub > 0 ? c.l.bidPriceRub : null,
    score: c.s?.score ?? null,
    score_version: c.s?.version ?? null,
    score_decision: c.s?.decision ?? null,
    stop_factor: c.s?.stopFactor ?? null,
    red_flags: c.s?.redFlags ?? [],
    score_reason: clip(c.s?.reason, 300),
    sorter_verdict: c.sorted.verdict ?? null,
    sorter_reason: clip(c.sorted.reason, 200),
    risk: clip(an.risk, 200),
    condition: clip(an.condition, 200),
    has_draft: c.l.draftText !== null,
    age_min: Math.max(0, Math.round((Date.now() - new Date(c.l.seenAt).getTime()) / 60_000)),
  }
}

/** What the reason guess reads (the order's title too, which never goes into the journal). */
function guessInputOf(c: Context): GuessInput {
  const info = (c.l.clientInfo ?? null) as { summaries?: { description?: unknown }[] } | null
  const axes = Array.isArray(c.s?.axes) ? (c.s.axes as { id?: unknown; score?: unknown }[]) : []
  return {
    title: c.l.title,
    category: c.l.category,
    budgetText: c.l.budgetText,
    feeRub: c.l.bidPriceRub > 0 ? c.l.bidPriceRub : null,
    score: c.s?.score ?? null,
    threshold: c.threshold,
    stopFactor: c.s?.stopFactor ?? null,
    redFlags: Array.isArray(c.s?.redFlags) ? (c.s.redFlags as string[]) : [],
    axes: axes.flatMap((a) =>
      typeof a.id === 'string' && typeof a.score === 'number' ? [{ id: a.id, score: a.score }] : [],
    ),
    clientLines: (info?.summaries ?? []).flatMap((s) =>
      typeof s.description === 'string' ? [s.description] : [],
    ),
  }
}

/**
 * Boris's decision as an example for the rules (one per lead, the first one counts). A surprise is a skip of a
 * card scored at least SURPRISE_ABOVE over the threshold, or «Взял бы» on an order Sara dropped. A no carries its
 * reason: Boris's own words when he gave them (the pult), else Sara's guess from the card (07.11.2026).
 */
export async function recordLabel(
  db: Db,
  l: { leadId: string; label: Label; source: LabelSource; reason?: string | null },
): Promise<{ created: boolean; surprise: boolean; reason: Reason | null; by: ReasonBy | null }> {
  return db.transaction(async (tx) => {
    const c = await contextOf(tx, l.leadId)
    const sc = c?.s ?? null
    let surprise = l.label === 'yes' && l.source === 'summary'
    if (
      sc &&
      c?.threshold != null &&
      l.label === 'no' &&
      (l.source === 'card' || l.source === 'pult')
    )
      surprise = sc.score >= c.threshold + SURPRISE_ABOVE
    const words = clip(l.reason, 300)
    const reason: Reason | null =
      l.label === 'yes'
        ? null
        : words
          ? reasonFromWords(words)
          : c
            ? guessReason(guessInputOf(c))
            : null
    const by: ReasonBy | null = l.label === 'yes' ? null : words ? 'boris' : 'guess'
    const now = new Date().toISOString()
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
        reasonCode: reason?.code ?? null,
        reasonDetail: reason?.detail ?? null,
        reasonBy: by,
        guessCode: by === 'guess' ? (reason?.code ?? null) : null,
        reasonAt: by ? now : null,
      })
      .onConflictDoNothing()
      .returning({ id: leadLabel.leadId })
    if (rows.length === 0) {
      const [was] = await tx.select().from(leadLabel).where(eq(leadLabel.leadId, l.leadId))
      return {
        created: false,
        surprise: false,
        reason: storedReason(was),
        by: was?.reasonBy === 'boris' || was?.reasonBy === 'guess' ? was.reasonBy : null,
      }
    }
    await appendEvent(tx, {
      type: 'lead.labeled',
      v: 1,
      entity: { kind: 'lead', id: l.leadId },
      account_id: c?.l.accountId ?? null,
      actor: l.source === 'ignored' ? 'system' : 'boris',
      occurred_at: now,
      causation_id: null,
      correlation_id: c?.l.correlationId ?? newEventId(),
      reason: null,
      payload: {
        label: l.label,
        source: l.source,
        surprise,
        ...(l.source === 'card' || l.source === 'pult'
          ? { features: c ? featuresOf(c) : null, reason: words }
          : {}),
        // The code only: «другое» in Boris's words keeps them in `reason` above, the guess holds no client words.
        ...(reason && { reason_code: reason.code, reason_by: by }),
      },
    })
    return { created: true, surprise, reason, by }
  })
}

function storedReason(
  row: { reasonCode: string | null; reasonDetail: string | null } | undefined,
): Reason | null {
  return row && isReasonCode(row.reasonCode)
    ? { code: row.reasonCode, detail: row.reasonDetail }
    : null
}

/**
 * The reason a folded card shows (07.11.2026), and the buttons that correct it: three other likely reasons and
 * «Другое». None once Boris chose; null for a lead without a no (a yes, or no label at all).
 */
export async function reasonOnCard(
  db: DbOrTx,
  leadId: string,
): Promise<{ reason: Reason | null; by: ReasonBy; buttons: ButtonCode[] } | null> {
  const [row] = await db.select().from(leadLabel).where(eq(leadLabel.leadId, leadId))
  if (!row || row.label === 'yes') return null
  const reason = storedReason(row)
  if (row.reasonBy === 'boris') return { reason, by: 'boris', buttons: [] }
  const c = await contextOf(db, leadId)
  const ranked = c ? rankReasons(guessInputOf(c)) : []
  return { reason, by: 'guess', buttons: reasonButtons(ranked, reason?.code ?? null) }
}

/**
 * Boris's one press on a reason under a folded card: it becomes his reason (the first guess is kept beside it) and
 * is journaled. Null when the lead has no no to explain.
 */
export async function setReason(
  db: Db,
  leadId: string,
  code: ReasonCode,
  at: Date,
): Promise<Reason | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(leadLabel)
      .where(eq(leadLabel.leadId, leadId))
      .for('update')
    if (!row || row.label === 'yes') return null
    const c = await contextOf(tx, leadId)
    const reason: Reason = {
      code,
      detail: code === 'other' || !c ? null : detailFor(rankReasons(guessInputOf(c)), code),
    }
    await tx
      .update(leadLabel)
      .set({
        reasonCode: reason.code,
        reasonDetail: reason.detail,
        reasonBy: 'boris',
        reasonAt: at.toISOString(),
      })
      .where(eq(leadLabel.leadId, leadId))
    await appendEvent(tx, {
      type: 'lead.reason_set',
      v: 1,
      entity: { kind: 'lead', id: leadId },
      account_id: c?.l.accountId ?? null,
      actor: 'boris',
      occurred_at: at.toISOString(),
      causation_id: null,
      correlation_id: c?.l.correlationId ?? newEventId(),
      reason: null,
      payload: {
        code: reason.code,
        detail: reason.detail,
        was: row.reasonCode,
        guess: row.guessCode,
      },
    })
    return reason
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
