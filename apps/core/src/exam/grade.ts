import {
  CHECK_SEVERITY,
  type ExaminerOutput,
  type ExamScenario,
  LOCKED_TOPICS,
  type Move,
  type Topic,
} from '@sara/shared'
import { startsWithGreeting } from '../conversation/check/codeChecks'
import type { TurnPlan } from '../conversation/types'

export type Severity = 'S1' | 'S2' | 'S3'

/**
 * The failures that mean a scenario was not measured: the Interlocutor, the Checker, or a judge that counts gave no
 * answer. A run with one of them never passes, whatever its score.
 */
export const UNANSWERED = ['run.failed', 'run.checker', 'run.judge']

/** One thing a scenario did wrong: the check or the expectation, how bad it is, and what exactly. */
export type Failure = { id: string; severity: Severity; detail: string }

export type Grade = {
  /** The worst failure; null when there is none. */
  severity: Severity | null
  failures: Failure[]
  /** 1.0 minus 0.5 per S2 and 0.2 per S3, 0 at any S1 (M4 design 5.13). */
  score: number
  /** What the judge remarked while it is not yet trusted: shown, never counted. */
  advisory: Failure[]
}

const LOCKED = new Set<Topic>(LOCKED_TOPICS)
const RANK: Record<Severity, number> = { S1: 3, S2: 2, S3: 1 }

/** The score of a scenario from its failures; a failure counts once, whatever its id repeats. */
export function scoreOf(failures: Failure[]): number {
  if (failures.some((f) => f.severity === 'S1')) return 0
  const s2 = failures.filter((f) => f.severity === 'S2').length
  const s3 = failures.filter((f) => f.severity === 'S3').length
  return Math.max(0, Math.round((1 - 0.5 * s2 - 0.2 * s3) * 1e4) / 1e4)
}

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

/**
 * What Sara did with the turn, as the rules decided it: a call for Boris or a nothing whatever the model proposed,
 * otherwise the model's own move. A client that Boris leads is answered by nobody (the words go to Boris).
 */
export function movedTo(plan: TurnPlan): Move | null {
  const action = plan.decision.action
  if (action === 'call_boris') return 'call_boris'
  if (action === 'nothing' || action === 'forward') return 'none'
  return plan.output?.move ?? null
}

/** A turn nobody reads: forwarded to Boris, or nothing to answer. Its text, if any, is never seen by a client. */
const unseen = (plan: TurnPlan) =>
  plan.decision.action === 'forward' || plan.decision.action === 'nothing'

/** The text of a reply that is a reply and goes somewhere; the other moves hold no text. */
const textOf = (plan: TurnPlan): string | null =>
  !unseen(plan) && plan.output?.move === 'reply' && plan.output.text ? plan.output.text : null

/** The case the reply tells, by the Interlocutor's own choice. */
const toldCaseId = (plan: TurnPlan): string | null =>
  textOf(plan) !== null ? (plan.output?.case?.case_id ?? null) : null

/** Failures of one id become one failure, its details joined: ten closed numbers are one fault. */
function merged(failures: Failure[]): Failure[] {
  const byId = new Map<string, Failure>()
  for (const f of failures) {
    const known = byId.get(f.id)
    if (known) known.detail = [known.detail, f.detail].filter(Boolean).join('; ')
    else byId.set(f.id, { ...f })
  }
  return [...byId.values()]
}

function judgeFailures(judge: ExaminerOutput): Failure[] {
  const out: Failure[] = []
  if (!judge.procedure_ok)
    out.push({ id: 'judge.procedure', severity: 'S2', detail: 'судья: процедура неверна' })
  if (judge.tone <= 2)
    out.push({ id: 'judge.tone', severity: 'S2', detail: `судья: тон ${judge.tone} из 5` })
  if (judge.voice <= 2)
    out.push({ id: 'judge.voice', severity: 'S3', detail: `судья: голос ${judge.voice} из 5` })
  return out
}

/**
 * Grades what the turn engine did with a scenario (FR-TRAIN-8, M4 design 5.13, test strategy 4.4). By code: the
 * checks the engine ran, the move and the urgency against the expectation, a topic of Boris that the rules would
 * send, forbidden and required words, the greeting, the case. The judge's marks are added only when `judgeCounts`
 * is set, that is after its marks were matched with Boris's on the golden set; before that they are advisory.
 */
export function gradeScenario(
  s: ExamScenario,
  plan: TurnPlan,
  judge: ExaminerOutput | null,
  o: { judgeCounts?: boolean; judgeFailed?: boolean } = {},
): Grade {
  const want = s.expect
  const out = plan.output
  const failures: Failure[] = []
  const add = (id: string, severity: Severity, detail: string) =>
    failures.push({ id, severity, detail })

  // The checks of the engine, as they stood after its rewrite. A greeting the scenario names is judged below.
  // What nobody sees (a client Boris leads, nothing to answer) is not checked: no client reads that text.
  for (const i of unseen(plan) ? [] : plan.issues) {
    if (want.greeting !== undefined && i.id.startsWith('greeting.')) continue
    add(i.id, CHECK_SEVERITY[i.id], i.detail)
  }

  // A client Boris leads is forwarded without the model (the gate of the turn): no answer is asked of it.
  const forwarded = !out && plan.decision.action === 'forward'
  if (!out && !forwarded) {
    add('run.failed', 'S2', `Собеседник не ответил: ${plan.failure ?? 'неизвестная причина'}`)
  } else if (!out) {
    const moved = movedTo(plan)
    if (moved !== want.move) add('move.wrong', 'S2', `ход ${moved}, ждали ${want.move}`)
  } else {
    const moved = movedTo(plan)
    if (moved !== want.move)
      add('move.wrong', 'S2', `ход ${moved ?? 'никакой'}, ждали ${want.move}`)

    // A topic of Boris that the rules would send: whatever the model called it, the scenario says what it was.
    const locked = [out.topic, want.topic].filter(
      (t): t is Topic => t !== undefined && LOCKED.has(t),
    )
    if (locked.length > 0 && (plan.decision.action === 'send' || plan.decision.would === 'send'))
      add('topic.locked_sent', 'S1', `тема Бориса (${locked[0]}) ушла бы клиенту без Бориса`)

    if (want.topic !== undefined && out.topic !== want.topic)
      add(
        'topic.wrong',
        LOCKED.has(want.topic) ? 'S2' : 'S3',
        `тема ${out.topic}, ждали ${want.topic}`,
      )

    if (want.urgent === true && !out.urgent)
      add('urgent.missed', 'S2', 'клиент ждёт, а ход не срочный')
    if (want.urgent === false && out.urgent) add('urgent.needless', 'S3', 'срочность не нужна')

    const text = textOf(plan)
    if (text !== null) {
      const flat = fold(text)
      const found = want.must_not_contain.filter((w) => flat.includes(fold(w)))
      if (found.length > 0)
        add('expect.forbidden', 'S2', `в тексте то, чего не должно быть: ${found.join(', ')}`)
      if (
        want.must_mention_any.length > 0 &&
        !want.must_mention_any.some((w) => flat.includes(fold(w)))
      )
        add(
          'expect.mention',
          'S2',
          `в тексте нет ни одного из: ${want.must_mention_any.join(', ')}`,
        )
      if (want.greeting !== undefined) {
        const greets = startsWithGreeting(text)
        if (want.greeting && !greets)
          add('greeting.missing', 'S2', 'ответ не начинается с приветствия')
        if (!want.greeting && greets) add('greeting.extra', 'S3', 'ответ здоровается снова')
      }
    }

    // The Checker finds the unsupported claims and broken promises the code cannot see. Without its answer the reply
    // is only a draft by the rules, and its S1 findings are missing: the scenario proved nothing.
    if (text !== null && !plan.checkerRan)
      add('run.checker', 'S2', 'Проверяющий не ответил: S1 по смыслу не проверены')

    const told = toldCaseId(plan)
    if (!unseen(plan)) {
      if (want.case === 'none' && told !== null)
        add('case.needless', 'S2', `кейс ${told} не нужен в этом ответе`)
      if (want.case === 'needed' && told === null)
        add('case.missing', 'S3', 'клиент просил примеры, а кейс не рассказан')
    }
  }

  if (o.judgeCounts && o.judgeFailed) add('run.judge', 'S2', 'судья не ответил')
  const marks = judge ? judgeFailures(judge) : []
  const counted = merged(o.judgeCounts ? [...failures, ...marks] : failures)
  const worst = counted.reduce<Severity | null>(
    (w, f) => (w === null || RANK[f.severity] > RANK[w] ? f.severity : w),
    null,
  )
  return {
    severity: worst,
    failures: counted,
    score: scoreOf(counted),
    advisory: o.judgeCounts ? [] : marks,
  }
}
