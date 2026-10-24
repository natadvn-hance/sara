import { DirectionRules, OnbAbout, OnbIdeal, type OnboardingStep, OnbStops } from '@sara/shared'
import type { ZodType } from 'zod'
import type { Gateway } from '../gateway/gateway'
import type { RoleName } from '../gateway/roles'
import { rulesText } from '../leads/scorer'

export type AboutData = Omit<OnbAbout, 'understood'>
export type StopsData = Omit<OnbStops, 'understood'>
export type IdealData = Omit<OnbIdeal, 'understood'>
export type StepData = AboutData | StopsData | IdealData

/** What earlier steps already fixed, so a later step does not contradict them (ids and the description only). */
export type Confirmed = { about?: string; stopFactorIds?: string[]; redFlagIds?: string[] }

export type StepInput = {
  /** Boris's words for this step. */
  say: string
  /** His correction after «Нет, поправить», with the attempt it is about. */
  fix?: string
  previous?: { understood: string }
  confirmed: Confirmed
  /** The active rules when Boris edits a direction instead of starting one. */
  current: DirectionRules | null
}

export type StepProposal =
  | { ok: true; understood: string; data: StepData }
  | { ok: false; reason: 'no_answer' | 'invalid' | 'limit' }

type StepSpec = {
  role: RoleName
  title: string
  schema: ZodType<{ understood: string }>
  /** What the code checks beyond the schema; a message is sent back to the model, null is fine. */
  check(data: never): string | null
}

const WEIGHTS = 'Веса осей должны давать в сумме ровно 100, а id осей быть разными.'
const IDS = 'Id стоп-факторов и красных флагов должны быть разными.'

/** The rules need an axis, so a step that has none borrows a placeholder to be checked as the rules would be. */
const PLACEHOLDER_AXES = [{ id: 'a', title: 'a', weight: 100, how: 'a' }]

const STEPS: Record<1 | 2 | 3, StepSpec> = {
  1: {
    role: 'onboarding-about',
    title: 'чем занимается аккаунт',
    schema: OnbAbout,
    check: () => null,
  },
  2: {
    role: 'onboarding-stops',
    title: 'чего не берём',
    schema: OnbStops,
    check: (d: StopsData) => {
      const ok = DirectionRules.safeParse({
        about: 'a',
        stop_factors: d.stop_factors,
        red_flags: d.red_flags,
        axes: PLACEHOLDER_AXES,
        threshold: 50,
        notes: [],
      }).success
      const flags = new Set(d.red_flags.map((f) => f.id))
      return ok && flags.size === d.red_flags.length ? null : IDS
    },
  },
  3: {
    role: 'onboarding-ideal',
    title: 'идеальная заявка',
    schema: OnbIdeal,
    check: (d: IdealData) =>
      DirectionRules.safeParse({
        about: 'a',
        stop_factors: [],
        red_flags: [],
        axes: d.axes,
        threshold: d.threshold,
        notes: d.notes,
      }).success
        ? null
        : WEIGHTS,
  },
}

function inputText(step: 1 | 2 | 3, i: StepInput): string {
  const lines = [`Шаг ${step}: ${STEPS[step].title}`]
  if (i.current)
    lines.push('', 'Действующие правила направления (Борис правит их):', rulesText(i.current))
  const c = i.confirmed
  const known = [
    c.about ? `Описание направления: ${c.about}` : null,
    c.stopFactorIds?.length ? `Стоп-факторы: ${c.stopFactorIds.join(', ')}` : null,
    c.redFlagIds?.length ? `Красные флаги: ${c.redFlagIds.join(', ')}` : null,
  ].filter((x): x is string => x !== null)
  if (known.length > 0) lines.push('', 'Подтверждено на прошлых шагах:', ...known)
  lines.push('', 'Слова Бориса:', i.say)
  if (i.previous) lines.push('', `Прошлая попытка Сары: «Я поняла так: ${i.previous.understood}»`)
  if (i.fix) lines.push('', `Поправка Бориса: ${i.fix}`)
  return lines.join('\n')
}

/**
 * Claude's reading of what Boris said for one step (FR-ACC-3). The answer is checked by the schema and by the
 * rules' own checks; one that fails is asked for once more, naming what was wrong, and a second failure is a miss
 * that touches nothing. The gateway never waits out a Claude limit here: Boris is looking at the screen.
 */
export async function proposeStep(
  d: { gateway: Gateway },
  step: Extract<OnboardingStep, 1 | 2 | 3>,
  input: StepInput,
): Promise<StepProposal> {
  const spec = STEPS[step]
  const base = inputText(step, input)
  let text = base
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await d.gateway.call(spec.role, text, spec.schema, { limitWaitMs: 0 })
    let wrong: string
    if (!r.ok) {
      if (r.errorClass === 'limit_reached') return { ok: false, reason: 'limit' }
      if (r.errorClass !== 'bad_output') return { ok: false, reason: 'no_answer' }
      wrong = 'Ответ не подошёл к схеме.'
    } else {
      const { understood, ...data } = r.output
      const bad = spec.check(data as never)
      if (!bad) return { ok: true, understood, data: data as StepData }
      wrong = bad
    }
    text = `${base}\n\nПрошлый ответ не подошёл: ${wrong} Ответь ещё раз по схеме.`
  }
  return { ok: false, reason: 'invalid' }
}
