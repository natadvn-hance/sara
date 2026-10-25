import { createHash } from 'node:crypto'
import type { DirectionRules } from '@sara/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { calibrationItem, directionRun, lead, trialScore as trialTable } from '../db/schema'
import { rulesHash } from './hash'
import { createRun, getRun, type RunRow } from './runStore'
import { type TrialDeps, trialScore } from './trial'

/** Calibration (FR-ACC-4): how many leads, from how few it can start, and what agreement lets a direction on. */
export const CALIBRATION_SIZE = 20
export const MIN_LEADS = 10
export const CALIBRATION_TARGET = 0.85
/** «Не знаю» is out of the agreement; with fewer decisive marks than this it says too little. */
export const MIN_DECISIVE = 15
/** Leads this far from the threshold (either side) are «near». */
const NEAR = 12
/** The share of each group in a full sample: near the threshold, clearly above, clearly below. */
const SHARE = { near: 8, above: 6, below: 6 } as const
const WINDOW_DAYS = 60
/** A threshold hint shows only for at least this much more agreement. */
const HINT_GAIN = 0.1

export type Mark = 'yes' | 'no' | 'unsure'

type Candidate = { id: string; score: number | null }

/** Leads of the account Boris can still be asked about, with their live score when they have one. */
async function candidates(db: DbOrTx, accountId: string): Promise<Candidate[]> {
  const r = await db.execute<Candidate>(sql`
    select l.id, (
      select s.score from core.lead_score s
      where s.lead_id = l.id and not s.backtest order by s.created_at desc limit 1
    ) as score
    from core.lead l
    where l.account_id = ${accountId}
      and l.status not in ('sorted_out', 'stale')
      and l.seen_at > now() - make_interval(days => ${WINDOW_DAYS})
      and not exists (
        select 1 from core.lead_label b where b.lead_id = l.id and b.source in ('card', 'summary'))`)
  return r.rows
}

const order = (seed: number) => (id: string) =>
  createHash('sha256').update(`${seed}:${id}`).digest('hex')

/**
 * The leads to ask Boris about: 8 near the threshold, 6 clearly above, 6 clearly below, a short group filled from
 * the nearest others. The order of the choice and of the result is fixed by `seed`, so a reload changes nothing.
 */
export function pickSample(
  pool: Candidate[],
  threshold: number,
  seed: number,
  size = CALIBRATION_SIZE,
): string[] {
  const key = order(seed)
  const sorted = [...pool].sort((a, b) => (key(a.id) < key(b.id) ? -1 : 1))
  const groups = {
    near: sorted.filter((c) => c.score !== null && Math.abs(c.score - threshold) <= NEAR),
    above: sorted.filter((c) => c.score !== null && c.score - threshold > NEAR),
    below: sorted.filter((c) => c.score !== null && threshold - c.score > NEAR),
    unknown: sorted.filter((c) => c.score === null),
  }
  const take: Candidate[] = []
  const used = new Set<string>()
  const add = (g: Candidate[], n: number) => {
    for (const c of g) {
      if (n <= 0 || take.length >= size) return
      if (used.has(c.id)) continue
      used.add(c.id)
      take.push(c)
      n--
    }
  }
  // Their own share first (scaled when the sample is smaller than 20), then the rest in order of nearness.
  const scale = size / CALIBRATION_SIZE
  for (const g of ['near', 'above', 'below'] as const) add(groups[g], Math.round(SHARE[g] * scale))
  for (const g of ['near', 'above', 'below', 'unknown'] as const) add(groups[g], size)
  return take.map((c) => c.id).sort((a, b) => (key(a) < key(b) ? -1 : 1))
}

export async function calibrationSample(
  db: DbOrTx,
  accountId: string,
  rules: DirectionRules,
  seed: number,
  size = CALIBRATION_SIZE,
): Promise<string[]> {
  return pickSample(await candidates(db, accountId), rules.threshold, seed, size)
}

export type StartResult =
  | { ok: true; runId: string; total: number }
  | { ok: false; error: 'no_leads' | 'too_few'; have: number }

/** A calibration of `rules` on a sample, waiting for Boris's marks. The sample is kept in the run. */
export async function startCalibration(
  db: Db,
  a: { accountId: string; rules: DirectionRules; seed?: number },
): Promise<StartResult> {
  const pool = await candidates(db, a.accountId)
  if (pool.length === 0) return { ok: false, error: 'no_leads', have: 0 }
  if (pool.length < MIN_LEADS) return { ok: false, error: 'too_few', have: pool.length }
  const seed = a.seed ?? Math.floor(Math.random() * 2 ** 31)
  const leadIds = pickSample(pool, a.rules.threshold, seed)
  const made = await createRun(db, {
    accountId: a.accountId,
    kind: 'calibration',
    rules: a.rules,
    baseRules: null,
    leadIds,
    seed,
    state: 'marking',
    inTx: async (tx, runId) => {
      await tx
        .insert(calibrationItem)
        .values(leadIds.map((leadId, position) => ({ runId, leadId, position })))
    },
  })
  // A run waiting for marks is never «busy»; the only refusal is its own.
  if (!made.ok) throw new Error('calibration run was refused')
  return { ok: true, runId: made.id, total: leadIds.length }
}

export type CalibrationItemView = {
  leadId: string
  title: string
  city: string
  budget: string | null
  text: string
  mark: Mark | null
}

/** What Boris sees while marking: the orders and his marks, never Sara's score or decision. */
export async function calibrationView(
  db: DbOrTx,
  runId: string,
): Promise<{ state: string; total: number; marked: number; items: CalibrationItemView[] }> {
  const [run] = await db.select().from(directionRun).where(eq(directionRun.id, runId))
  if (!run) throw new Error(`no run ${runId}`)
  const rows = await db
    .select({
      leadId: calibrationItem.leadId,
      title: lead.title,
      city: lead.city,
      budget: lead.budgetText,
      text: lead.text,
      mark: calibrationItem.mark,
    })
    .from(calibrationItem)
    .innerJoin(lead, eq(lead.id, calibrationItem.leadId))
    .where(eq(calibrationItem.runId, runId))
    .orderBy(calibrationItem.position)
  const items = rows.map((r) => ({ ...r, mark: (r.mark as Mark | null) ?? null }))
  return {
    state: run.state,
    total: run.total,
    marked: items.filter((i) => i.mark !== null).length,
    items,
  }
}

export type MarkResult =
  | { ok: true; marked: number; total: number; complete: boolean }
  | { ok: false; error: 'not_marking' | 'no_item' }

/**
 * Boris's mark on one lead; marking it again replaces the mark. The last mark sends the run to scoring (the
 * caller then schedules it); marks are accepted only while the run waits for them.
 */
export async function markItem(
  db: Db,
  runId: string,
  leadId: string,
  mark: Mark,
  note?: string,
): Promise<MarkResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`calibration:${runId}`}))`)
    const run = await getRun(tx as unknown as Db, runId)
    if (!run || run.state !== 'marking')
      return { ok: false as const, error: 'not_marking' as const }
    const done = await tx
      .update(calibrationItem)
      .set({
        mark,
        ...(note !== undefined ? { note } : {}),
        markedAt: new Date().toISOString(),
      })
      .where(and(eq(calibrationItem.runId, runId), eq(calibrationItem.leadId, leadId)))
      .returning({ leadId: calibrationItem.leadId })
    if (done.length === 0) return { ok: false as const, error: 'no_item' as const }
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(calibrationItem)
      .where(and(eq(calibrationItem.runId, runId), sql`${calibrationItem.mark} is not null`))
    const complete = n >= run.total
    // Every mark is a sign of life, so a calibration marked over hours is not swept as a dead run, and the one
    // that waits for its turn after the last mark starts that wait fresh.
    await tx
      .update(directionRun)
      .set({ updatedAt: new Date().toISOString(), ...(complete ? { state: 'queued' } : {}) })
      .where(eq(directionRun.id, runId))
    return { ok: true as const, marked: n, total: run.total, complete }
  })
}

/** Boris's words on why he decided so about a lead, kept beside the mark. */
export async function setNote(
  db: Db,
  runId: string,
  leadId: string,
  note: string,
): Promise<boolean> {
  const done = await db
    .update(calibrationItem)
    .set({ note })
    .where(and(eq(calibrationItem.runId, runId), eq(calibrationItem.leadId, leadId)))
    .returning({ leadId: calibrationItem.leadId })
  return done.length > 0
}

/** One lead of a calibration: scored as in work (sonnet near the threshold) under the run's rules. */
export async function calibrationProcess(
  d: TrialDeps,
  run: RunRow,
  leadId: string,
): Promise<'ok' | 'miss'> {
  const version = run.scorerVersion ?? undefined
  return (await trialScore(d, leadId, run.rules as DirectionRules, 'escalated', version))
    ? 'ok'
    : 'miss'
}

export type Miss = {
  leadId: string
  title: string
  city: string
  text: string
  /** `sara_no_boris_yes` is a lost lead and comes first. */
  kind: 'sara_no_boris_yes' | 'sara_yes_boris_no'
  score: number
  reason: string
  axes: { id: string; score: number; why: string }[]
  stopFactor: string | null
  redFlags: string[]
  note: string | null
}

export type ThresholdHint = { from: number; to: number; before: number; after: number }

export type CalibrationResult = {
  decisive: number
  unsure: number
  agreement: number | null
  reliable: boolean
  passed: boolean
  threshold: number
  misses: Miss[]
  thresholdHint: ThresholdHint | null
}

type Scored = { mark: 'yes' | 'no'; score: number; stopFactor: string | null }

const agreementAt = (items: Scored[], threshold: number): number =>
  items.filter((i) => (!i.stopFactor && i.score >= threshold ? 'yes' : 'no') === i.mark).length /
  items.length

/**
 * The threshold that would agree with Boris the most, nearest to the current one (of two equally near, the lower);
 * null without a clear gain.
 */
function hintOf(items: Scored[], current: number): ThresholdHint | null {
  if (items.length === 0) return null
  const before = agreementAt(items, current)
  let best = { t: current, a: before }
  for (let t = 0; t <= 100; t++) {
    const a = agreementAt(items, t)
    const closer = Math.abs(t - current) < Math.abs(best.t - current)
    if (a > best.a || (a === best.a && closer && t !== current)) best = { t, a }
  }
  return best.a - before >= HINT_GAIN - 1e-9 && best.t !== current
    ? { from: current, to: best.t, before, after: best.a }
    : null
}

/** What a calibration found: agreement with Boris, the leads where they differ, and a better threshold if any. */
export async function calibrationResult(db: DbOrTx, runId: string): Promise<CalibrationResult> {
  const [run] = await db.select().from(directionRun).where(eq(directionRun.id, runId))
  if (!run) throw new Error(`no run ${runId}`)
  const rules = run.rules as DirectionRules
  const items = await db
    .select()
    .from(calibrationItem)
    .where(eq(calibrationItem.runId, runId))
    .orderBy(calibrationItem.position)
  const ids = items.map((i) => i.leadId)
  const scores = ids.length
    ? await db
        .selectDistinctOn([trialTable.leadId])
        .from(trialTable)
        .where(
          and(
            eq(trialTable.rulesHash, run.rulesHash),
            eq(trialTable.mode, 'escalated'),
            // Only the scores of the prompt version this run used.
            ...(run.scorerVersion === null ? [] : [eq(trialTable.roleVersion, run.scorerVersion)]),
            inArray(trialTable.leadId, ids),
          ),
        )
        .orderBy(trialTable.leadId, desc(trialTable.createdAt))
    : []
  const leads = ids.length ? await db.select().from(lead).where(inArray(lead.id, ids)) : []
  const decided: Scored[] = []
  const misses: Miss[] = []
  for (const i of items) {
    const t = scores.find((s) => s.leadId === i.leadId)
    if ((i.mark !== 'yes' && i.mark !== 'no') || !t) continue
    decided.push({ mark: i.mark, score: t.score, stopFactor: t.stopFactor })
    const sara = t.decision === 'show' ? 'yes' : 'no'
    if (sara === i.mark) continue
    const l = leads.find((x) => x.id === i.leadId)
    misses.push({
      leadId: i.leadId,
      title: l?.title ?? '',
      city: l?.city ?? '',
      text: l?.text ?? '',
      kind: i.mark === 'yes' ? 'sara_no_boris_yes' : 'sara_yes_boris_no',
      score: t.score,
      reason: t.reason,
      axes: t.axes as Miss['axes'],
      stopFactor: t.stopFactor,
      redFlags: t.redFlags as string[],
      note: i.note,
    })
  }
  misses.sort(
    (a, b) => Number(b.kind === 'sara_no_boris_yes') - Number(a.kind === 'sara_no_boris_yes'),
  )
  const agreeing = decided.length - misses.length
  const agreement = decided.length > 0 ? agreeing / decided.length : null
  const reliable = decided.length >= MIN_DECISIVE
  return {
    decisive: decided.length,
    unsure: items.filter((i) => i.mark === 'unsure').length,
    agreement,
    reliable,
    passed: reliable && agreement !== null && agreement >= CALIBRATION_TARGET,
    threshold: rules.threshold,
    misses,
    thresholdHint: hintOf(decided, rules.threshold),
  }
}

/** Whether a finished calibration of exactly these rules reached the target (the gate for turning rules on). */
export async function calibrationPassed(
  db: DbOrTx,
  accountId: string,
  rules: DirectionRules,
): Promise<boolean> {
  const [run] = await db
    .select({ id: directionRun.id })
    .from(directionRun)
    .where(
      and(
        eq(directionRun.accountId, accountId),
        eq(directionRun.kind, 'calibration'),
        eq(directionRun.rulesHash, rulesHash(rules)),
        eq(directionRun.state, 'done'),
      ),
    )
    .orderBy(desc(directionRun.createdAt))
    .limit(1)
  return run ? (await calibrationResult(db, run.id)).passed : false
}

export type CalibrationSummary = {
  runId: string
  state: string
  agreement: number | null
  decisive: number
  passed: boolean
  reliable: boolean
}

/** The latest calibration of exactly these rules, in short, for the onboarding screens; null if there is none. */
export async function latestCalibration(
  db: DbOrTx,
  accountId: string,
  rules: DirectionRules,
): Promise<CalibrationSummary | null> {
  const [run] = await db
    .select({ id: directionRun.id, state: directionRun.state })
    .from(directionRun)
    .where(
      and(
        eq(directionRun.accountId, accountId),
        eq(directionRun.kind, 'calibration'),
        eq(directionRun.rulesHash, rulesHash(rules)),
      ),
    )
    .orderBy(desc(directionRun.createdAt))
    .limit(1)
  if (!run) return null
  if (run.state !== 'done')
    return {
      runId: run.id,
      state: run.state,
      agreement: null,
      decisive: 0,
      passed: false,
      reliable: false,
    }
  const r = await calibrationResult(db, run.id)
  return {
    runId: run.id,
    state: run.state,
    agreement: r.agreement,
    decisive: r.decisive,
    passed: r.passed,
    reliable: r.reliable,
  }
}
