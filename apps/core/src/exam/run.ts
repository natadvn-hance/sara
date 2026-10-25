import { createHash } from 'node:crypto'
import {
  ExaminerOutput,
  type ExamScenario,
  LOCKED_TOPICS,
  newEventId,
  TOPICS,
  type Topic,
} from '@sara/shared'
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm'
import { loadConfig } from '../config'
import { planTurn } from '../conversation/engine'
import type { MindSearch, PolicySettings, TurnPlan } from '../conversation/types'
import type { Db } from '../db/client'
import { examResult, examRun } from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import { loadRole } from '../gateway/roles'
import { appendEvent } from '../journal/journal'
import { type Grade, gradeScenario, movedTo } from './grade'
import { formatExaminerInput } from './prompt'
import { caseHitOf, dossierFromScenario, examNames, loadScenarios } from './scenarios'

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

/** A score that went through a 4-byte float column is the same score within this. */
const SAME = 1e-6

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
}

export type ExamSummary = {
  runId: string
  mindVersion: string
  score: number
  s1: number
  s2: number
  s3: number
  passed: boolean
  /** In how many scenarios the Interlocutor gave no answer: such a run measures nothing and never passes. */
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
  const rolesVersion: Record<string, number> = {}
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
    const grade = gradeScenario(s, plan, marks, { judgeCounts })
    const out = plan.output
    const result: ScenarioResult = {
      id: s.id,
      title: s.title,
      move: movedTo(plan),
      text: out?.move === 'reply' ? out.text : null,
      grade,
      judge,
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
  const unanswered = failures.filter((f) => f.id === 'run.failed').length
  const [previous] = await d.db
    .select({ id: examRun.id, score: examRun.score })
    .from(examRun)
    .where(
      and(
        eq(examRun.scenarioSet, setKey),
        ne(examRun.id, runId),
        // Only a run that passed is a baseline: a failed one (an S1, an unanswered scenario, a worse score) is the
        // very thing the next run must not be allowed to match.
        eq(examRun.passed, true),
        isNotNull(examRun.finishedAt),
        isNotNull(examRun.score),
      ),
    )
    .orderBy(desc(examRun.finishedAt), desc(examRun.startedAt))
    .limit(1)
  const before = previous?.score == null ? null : { id: previous.id, score: previous.score }
  const summary: ExamSummary = {
    runId,
    mindVersion,
    score,
    s1,
    s2: countOf('S2'),
    s3: countOf('S3'),
    passed: unanswered === 0 && examVerdict({ score, s1 }, before),
    unanswered,
    scenarios: results.length,
    comparedTo: before?.id ?? null,
    previousScore: before?.score ?? null,
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
