import { DirectionRules, RulesProposalOutput } from '@sara/shared'
import { eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { directionRun, lead } from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import { rulesText } from '../leads/scorer'
import { sorterInput } from '../leads/sorter'
import { calibrationResult, type Miss } from './calibration'
import { rulesDiff } from './diff'
import { applyRulesToDraft, getOnboarding } from './onboarding'
import { createRun, finishRun, getRun, type RunRow } from './runStore'
import { activeRules } from './store'
import { orderOfLead } from './trial'

/** The misses the proposer is shown, the way the learning loop shows it its cases. */
const MISSES_MAX = 20

export type Advice = { summary: string; why: string; lines: string[]; rules: DirectionRules }

export type AdviseResult =
  | { ok: true; advice: Advice }
  | {
      ok: false
      reason: 'no_run' | 'no_misses' | 'invalid' | 'not_one_change' | 'no_answer' | 'limit'
    }

const decisionOf = (m: Miss) =>
  m.kind === 'sara_no_boris_yes'
    ? 'отметил «взяли бы» (Сара отсеяла)'
    : 'отметил «нет» (Сара показала)'

/**
 * One change of the rules that the calibration's misses point to (the learning loop's proposer, FR-ACC-4), as a
 * proposal: it must be exactly one section changed and the rules must still be valid. It is kept on the run; the
 * agreement it would give is found when it is applied, by a new calibration of the same marked sample.
 */
export async function adviseRules(
  d: { db: Db; gateway: Gateway },
  accountId: string,
  runId: string,
): Promise<AdviseResult> {
  const run = await getRun(d.db, runId)
  if (!run || run.accountId !== accountId || run.kind !== 'calibration' || run.state !== 'done')
    return { ok: false, reason: 'no_run' }
  const result = await calibrationResult(d.db, runId)
  const misses = result.misses.slice(0, MISSES_MAX)
  if (misses.length === 0) return { ok: false, reason: 'no_misses' }
  // Read through the contract, so its keys come in the order a diff of rules expects, not the jsonb's.
  const rules = DirectionRules.parse(run.rules)
  const rows = await d.db
    .select()
    .from(lead)
    .where(
      inArray(
        lead.id,
        misses.map((m) => m.leadId),
      ),
    )
  const cases = misses.map((m, i) => {
    const row = rows.find((r) => r.id === m.leadId)
    // The client's name never goes to the model: the order is read the way the Scorer reads it.
    const order = row ? sorterInput(orderOfLead(row)) : `Тема: ${m.title}\nОписание: ${m.text}`
    return `Случай ${i + 1}\n${order}\nБалл Сары: ${m.score}\nБорис: ${decisionOf(m)}\nЕго причина: ${m.note ?? 'не назвал'}`
  })
  const input = [
    'Правила, которые проверяли',
    rulesText(rules),
    '',
    'Те же правила в JSON:',
    JSON.stringify(rules),
    '',
    'Случаи, где отметка Бориса разошлась с оценкой Сары:',
    ...cases,
  ].join('\n')
  const r = await d.gateway.call('rules-proposer', input, RulesProposalOutput, { limitWaitMs: 0 })
  if (!r.ok) {
    if (r.errorClass === 'limit_reached') return { ok: false, reason: 'limit' }
    return { ok: false, reason: r.errorClass === 'bad_output' ? 'invalid' : 'no_answer' }
  }
  const proposed = DirectionRules.safeParse(r.output.rules)
  if (!proposed.success) return { ok: false, reason: 'invalid' }
  const diff = rulesDiff(rules, proposed.data)
  if (diff.sections.length !== 1) return { ok: false, reason: 'not_one_change' }
  const advice: Advice = {
    summary: r.output.summary,
    why: r.output.why,
    lines: diff.lines,
    rules: proposed.data,
  }
  await d.db.update(directionRun).set({ advice }).where(eq(directionRun.id, runId))
  return { ok: true, advice }
}

/**
 * A new calibration of `rules` on the same leads with the same marks and notes, waiting to be scored: Boris does
 * not mark again. Refused when another check is going on.
 */
async function repeatCalibration(
  db: Db,
  old: RunRow,
  rules: DirectionRules,
): Promise<{ ok: true; runId: string } | { ok: false; error: 'busy' }> {
  const made = await createRun(db, {
    accountId: old.accountId,
    kind: 'calibration',
    rules,
    baseRules: null,
    leadIds: old.leadIds as string[],
    seed: old.seed,
    inTx: async (tx, id) => {
      await tx.execute(sql`
        insert into core.calibration_item (run_id, lead_id, position, mark, note, marked_at)
        select ${id}::uuid, lead_id, position, mark, note, marked_at
        from core.calibration_item where run_id = ${old.id}::uuid`)
    },
  })
  return made.ok ? { ok: true, runId: made.id } : made
}

export type ApplyResult =
  | { ok: true; runId: string }
  | { ok: false; error: 'no_run' | 'no_advice' | 'no_hint' | 'busy' }

/**
 * «Применить к черновику»: the advice, or the better threshold the calibration found, goes into the draft (no
 * version is made) and the same marked sample is scored again under the new rules. The new run is made first, so
 * a busy system leaves the draft as it was.
 */
export async function applyAdvice(
  db: Db,
  accountId: string,
  runId: string,
  source: 'advice' | 'threshold',
): Promise<ApplyResult> {
  const run = await getRun(db, runId)
  if (!run || run.accountId !== accountId || run.kind !== 'calibration')
    return { ok: false, error: 'no_run' }
  let to: DirectionRules
  let understood: string
  if (source === 'advice') {
    const parsed = DirectionRules.safeParse((run.advice as Advice | null)?.rules)
    if (!parsed.success) return { ok: false, error: 'no_advice' }
    to = parsed.data
    understood = `Поправка после калибровки: ${(run.advice as Advice).summary}`
  } else {
    const hint = run.state === 'done' ? (await calibrationResult(db, runId)).thresholdHint : null
    if (!hint) return { ok: false, error: 'no_hint' }
    to = { ...DirectionRules.parse(run.rules), threshold: hint.to }
    understood = `Порог после калибровки: ${hint.from} → ${hint.to}`
  }
  const next = await repeatCalibration(db, run, to)
  if (!next.ok) return next
  try {
    await applyRulesToDraft(db, accountId, to, understood)
  } catch (e) {
    // The draft did not take it: the run made for it must not go on alone.
    const made = await getRun(db, next.runId)
    if (made) await finishRun(db, made, 'failed', 'error')
    throw e
  }
  return next
}

/**
 * The calibration of the rules as they are now (the draft when one is open, else the active ones) on the same
 * marked sample, for a draft that changed after its calibration.
 */
export async function recalibrate(
  db: Db,
  accountId: string,
  runId: string,
): Promise<{ ok: true; runId: string } | { ok: false; error: 'no_run' | 'busy' }> {
  const run = await getRun(db, runId)
  if (!run || run.accountId !== accountId || run.kind !== 'calibration')
    return { ok: false, error: 'no_run' }
  const view = await getOnboarding(db, accountId)
  const rules = view?.rules ?? (await activeRules(db, accountId)).rules
  return repeatCalibration(db, run, rules)
}
