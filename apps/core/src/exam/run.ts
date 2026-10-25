import { createHash } from 'node:crypto'
import {
  ExaminerOutput,
  type ExamScenario,
  LOCKED_TOPICS,
  newEventId,
  TOPICS,
  type Topic,
} from '@sara/shared'
import { eq } from 'drizzle-orm'
import { loadConfig } from '../config'
import { planTurn } from '../conversation/engine'
import type { MindSearch, PolicySettings, TurnPlan } from '../conversation/types'
import type { Db } from '../db/client'
import { examResult, examRun } from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import { loadRole } from '../gateway/roles'
import { appendEvent } from '../journal/journal'
import { type Baseline, findBaseline, gotWorse, SAME } from './baseline'
import { type Grade, gradeScenario, movedTo, UNANSWERED } from './grade'
import { formatExaminerInput } from './prompt'
import { caseHitOf, dossierFromScenario, examNames, loadScenarios, scenarioHash } from './scenarios'

const LOCKED = new Set<Topic>(LOCKED_TOPICS)

/**
 * The rules the exam decides by: the mode after the switch (Sara may write to clients), set here and never read from
 * or written to the database. The topics of Boris stay `call`, every other topic is `self`: the exam asks what the
 * rules would send if Sara were free to answer on every topic, so a topic of Boris that slips through shows as a
 * `send`, and a topic Boris raises later is already tested.
 */
export const EXAM_SETTINGS: PolicySettings = {
  v1Writes: false,
  outboundMessages: true,
  accountPaused: false,
  night: { from: 23, to: 8 },
  autonomy: Object.fromEntries(
    TOPICS.map((t) => [t, LOCKED.has(t) ? 'call' : 'self']),
  ) as PolicySettings['autonomy'],
}

/**
 * The deploy guard (FR-TRAIN-8): no S1, and a score not worse than the last run of the same set that passed. A run in which the
 * Interlocutor did not answer somewhere does not pass whatever its score (see `unanswered`).
 */
export function examVerdict(
  run: { score: number; s1: number },
  previous: { score: number } | null,
): boolean {
  return run.s1 === 0 && (previous === null || run.score + SAME >= previous.score)
}

/** The exam cannot start as asked: a set that does not read, a number no scenario has, nothing to run. */
export class ExamSetupError extends Error {}

export type ExamDeps = {
  db: Db
  gateway: Gateway
  mind: MindSearch
  /** Where the roles live: their versions are stored with the run. Default: the configured folder. */
  rolesDir?: string
}

export type ExamOptions = {
  dirs: string[]
  /** Only these scenarios; such a run is a set of its own and never stands for the whole exam. */
  only?: string[]
  judge: boolean
  /** The judge's marks count in the score: only once they were matched with Boris's on the golden set. */
  judgeCounts?: boolean
  /** How many scenarios run at once (default 1). */
  concurrency?: number
  /**
   * The guard run (`--compare`): a run with no run that passed to compare with does not pass, and so never becomes a
   * baseline. Without it such a run, if clean, passes: that is how the first baseline is made, by running the
   * version that is deployed.
   */
  guard?: boolean
  /** The mind scope of the dossiers (default `shared`). */
  scope?: string
  /** Called with each scenario's result when it is done, in the order they finish. */
  onResult?: (r: ScenarioResult) => void
}

/** The judge's marks; `failed` is the error class of a judge call that did not answer; null: not asked. */
export type JudgeRecord = ExaminerOutput | { failed: string } | null

export type ScenarioResult = {
  id: string
  title: string
  move: string | null
  text: string | null
  grade: Grade
  judge: JudgeRecord
  /** The mind version the engine read for this scenario; null when it read none (the engine broke). */
  mindVersion: string | null
}

export type ExamSummary = {
  runId: string
  mindVersion: string
  score: number
  s1: number
  s2: number
  s3: number
  passed: boolean
  /** The key of the set the run was of, as stored in `exam_run.scenario_set`. */
  setHash: string
  /** What the run was compared with: the same set, another set on the scenarios not changed since, or nothing. */
  baseline: Baseline['kind'] | null
  /** How many scenarios were compared with the baseline. */
  overlap: number
  /** The scenarios that got worse than in the baseline. */
  worse: string[]
  /** In how many scenarios the engine read another mind version than the run began with: such a run never passes. */
  mindShifted: number
  /** In how many scenarios a model gave no answer (the Interlocutor, the Checker, a judge that counts): the run never passes. */
  unanswered: number
  scenarios: number
  /** The earlier run of the same set that this one was compared with, if any. */
  comparedTo: string | null
  previousScore: number | null
  results: ScenarioResult[]
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4

/** The mind of one scenario: the search of the exam's mind, with the scenario's own invented cases. */
export function scenarioMind(mind: MindSearch, s: ExamScenario): MindSearch {
  const cases = s.cases.map(caseHitOf)
  return {
    ...mind,
    cases: async (q) => cases.filter((c) => !q.exclude?.includes(c.id)).slice(0, q.limit),
  }
}

/** The exam is background work: its calls go after the live ones, and wait out the Claude limit. */
function inTheBackground(gateway: Gateway): Gateway {
  return {
    call: (role, input, schema, opts) =>
      gateway.call(role, input, schema, { ...opts, priority: 'P3' }),
  }
}

/** The plan of a scenario whose engine broke: nothing answered, the reason kept. */
function brokenPlan(e: unknown): TurnPlan {
  return {
    recall: {
      mindVersion: '',
      understanding: [],
      knowledge: [],
      examples: [],
      procedure: null,
      always: [],
      cases: [],
    },
    output: null,
    issues: [],
    attempts: 0,
    decision: { action: 'draft', would: 'draft', reason: 'движок хода упал', holdUntil: null },
    modelCallIds: [],
    checkerRan: false,
    failure: `engine: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
  }
}

/**
 * Runs the exam (FR-TRAIN-8, M4 design 5.13): for each scenario the same turn engine as in work (steps 2-6, no sending
 * and no outbox), the rules in the mode after the switch, and the grade. The run, its mind version, the versions of the
 * roles and every scenario's result are stored. `passed` is the deploy guard: no S1, and a score not worse than the last
 * run of the same set. Nothing of a conversation is written: no turn, no message, no setting.
 */
export async function runExam(d: ExamDeps, o: ExamOptions): Promise<ExamSummary> {
  const loaded = await loadScenarios(o.dirs)
  if (loaded.errors.length > 0)
    throw new ExamSetupError(
      `Сценарии экзамена не читаются: ${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
    )
  const ids = [...new Set(o.only ?? [])].sort()
  const known = new Set(loaded.scenarios.map((s) => s.id))
  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length > 0)
    throw new ExamSetupError(`Нет сценариев с номерами: ${unknown.join(', ')}`)
  const chosen =
    ids.length > 0 ? loaded.scenarios.filter((s) => ids.includes(s.id)) : loaded.scenarios
  if (chosen.length === 0) throw new ExamSetupError('Нет ни одного сценария: нечего проверять.')

  const judgeCounts = o.judge && o.judgeCounts === true
  // A part of the set, or a judge that counts, is another set: its score is not the score of the whole exam.
  const setKey = [
    ids.length > 0
      ? createHash('sha256')
          .update(`${loaded.setHash}:${ids.join(',')}`)
          .digest('hex')
          .slice(0, 16)
      : loaded.setHash,
    ...(judgeCounts ? ['judge'] : []),
  ].join('+')

  const rolesDir = d.rolesDir ?? loadConfig().rolesDir
  // The versions of the roles, and what the next run needs to know of this one's scenarios (see RunMeta).
  const hashes = new Map(chosen.map((s) => [s.id, scenarioHash(s)]))
  const rolesVersion: Record<string, unknown> = {
    scenarios: Object.fromEntries(hashes),
    partial: ids.length > 0,
  }
  for (const role of ['interlocutor', 'checker', 'examiner'] as const)
    rolesVersion[role] = (await loadRole(rolesDir, role)).meta.version
  const mindVersion = await d.mind.version()

  const runId = newEventId()
  await d.db.insert(examRun).values({ id: runId, mindVersion, rolesVersion, scenarioSet: setKey })
  const gateway = inTheBackground(d.gateway)

  async function examine(s: ExamScenario): Promise<ScenarioResult> {
    // One correlation number for the whole run: `pnpm trace <run>` shows every call of it.
    const dossier = { ...dossierFromScenario(s, o.scope ?? 'shared'), conversationId: runId }
    const names = examNames(s)
    let plan: TurnPlan
    try {
      plan = await planTurn(
        { gateway, mind: scenarioMind(d.mind, s) },
        { dossier, names, settings: EXAM_SETTINGS, now: new Date(s.now) },
      )
    } catch (e) {
      plan = brokenPlan(e)
    }
    let judge: JudgeRecord = null
    if (o.judge && plan.output) {
      const r = await gateway.call(
        'examiner',
        formatExaminerInput(s, plan, dossier),
        ExaminerOutput,
        {
          correlationId: runId,
          redact: { names },
        },
      )
      judge = r.ok ? r.output : { failed: r.errorClass }
    }
    const marks = judge && 'tone' in judge ? judge : null
    const grade = gradeScenario(s, plan, marks, {
      judgeCounts,
      judgeFailed: judge !== null && 'failed' in judge,
    })
    const out = plan.output
    const result: ScenarioResult = {
      id: s.id,
      title: s.title,
      move: movedTo(plan),
      text: out?.move === 'reply' ? out.text : null,
      grade,
      judge,
      mindVersion: plan.recall.mindVersion || null,
    }
    await d.db.insert(examResult).values({
      runId,
      scenarioId: s.id,
      move: result.move,
      text: result.text,
      checks: grade.failures,
      judge: marks ? { ...marks, counted: judgeCounts } : judge,
      severity: grade.severity,
      score: grade.score,
    })
    o.onResult?.(result)
    return result
  }

  const queue = [...chosen]
  const results: ScenarioResult[] = []
  const workers = Math.max(1, Math.min(o.concurrency ?? 1, chosen.length))
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) results.push(await examine(s))
    }),
  )
  results.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const failures = results.flatMap((r) => r.grade.failures)
  const countOf = (sev: string) => failures.filter((f) => f.severity === sev).length
  const score = round4(results.reduce((sum, r) => sum + r.grade.score, 0) / results.length)
  const s1 = countOf('S1')
  const mindShifted = results.filter(
    (r) => r.mindVersion !== null && r.mindVersion !== mindVersion,
  ).length
  const unanswered = failures.filter((f) => UNANSWERED.includes(f.id)).length
  const baseline = await findBaseline(d.db, { setKey, hashes, runId })
  const worse = gotWorse(
    baseline,
    results.map((r) => ({ id: r.id, score: r.grade.score })),
  )
  const summary: ExamSummary = {
    runId,
    mindVersion,
    score,
    s1,
    s2: countOf('S2'),
    s3: countOf('S3'),
    passed:
      unanswered === 0 &&
      mindShifted === 0 &&
      worse.length === 0 &&
      examVerdict({ score, s1 }, baseline?.kind === 'same' ? baseline : null) &&
      // A guard run with nothing to compare with proved nothing.
      !(o.guard && baseline === null),
    setHash: setKey,
    baseline: baseline?.kind ?? null,
    overlap: baseline?.scores.size ?? 0,
    worse,
    unanswered,
    mindShifted,
    scenarios: results.length,
    comparedTo: baseline?.id ?? null,
    previousScore: baseline?.score ?? null,
    results,
  }
  await d.db
    .update(examRun)
    .set({
      finishedAt: new Date().toISOString(),
      score,
      s1: summary.s1,
      s2: summary.s2,
      s3: summary.s3,
      passed: summary.passed,
      comparedTo: summary.comparedTo,
    })
    .where(eq(examRun.id, runId))
  await appendEvent(d.db, {
    type: 'exam.finished',
    v: 1,
    entity: { kind: 'exam_run', id: runId },
    account_id: null,
    actor: 'system',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: runId,
    reason: null,
    payload: {
      score,
      s1: summary.s1,
      s2: summary.s2,
      s3: summary.s3,
      passed: summary.passed,
      scenarios: results.length,
    },
  })
  return summary
}
