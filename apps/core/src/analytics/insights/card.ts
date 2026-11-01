import { z } from 'zod'
import { DIM_HINT, DIM_RU, type Finding, OUTCOME_RU } from './findings'
import { casesNeeded } from './stats'

/** What the role answers: one text per finding it was given, tied to it by the fingerprint. */
export const InsightOutput = z.object({
  cards: z
    .array(z.object({ fingerprint: z.string().min(1), text: z.string().min(40).max(900) }))
    .max(2),
})
export type InsightOutput = z.infer<typeof InsightOutput>

const fmtDay = (iso: string) => iso.split('-').reverse().slice(0, 2).join('.')
const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`)

/** How many more cases a small group needs for the gap to count as a conclusion, and about how many days that is. */
export function needMore(f: Finding): { need: number; days: number } {
  const small = Math.min(f.gap.a.n, f.gap.b.n)
  const need = casesNeeded(f.gap.pa, f.gap.pb, small)
  const days = Math.max(
    1,
    Math.round((Date.parse(`${f.to}T00:00:00Z`) - Date.parse(`${f.from}T00:00:00Z`)) / 86400000) +
      1,
  )
  const perDay = small / days
  const extra = Math.max(0, need - small)
  return { need, days: perDay > 0 ? Math.min(90, Math.max(1, Math.ceil(extra / perDay))) : 90 }
}

/** The facts of one finding as the role gets them: every number the card may say is here. */
export function factsOf(f: Finding) {
  const { need, days } = needMore(f)
  return {
    fingerprint: f.fingerprint,
    level: f.level === 'conclusion' ? 'вывод' : 'ранний сигнал',
    what: OUTCOME_RU[f.outcome],
    slice: f.group,
    dimension: DIM_RU[f.dim],
    group: { k: f.gap.a.k, n: f.gap.a.n, percent: f.gap.pa },
    rest: { k: f.gap.b.k, n: f.gap.b.n, percent: f.gap.pb },
    diff_points: f.gap.diffPp,
    period: `${fmtDay(f.from)}-${fmtDay(f.to)}`,
    source: f.source,
    need_in_group: need,
    wait_days: days,
    mechanism_idea: DIM_HINT[f.dim].mechanism,
    check_idea: DIM_HINT[f.dim].check,
  }
}

const num = /\d+(?:[  ]\d{3})*(?:[.,]\d+)?/g
const canon = (s: string) => s.replace(/[  ]/g, '').replace(',', '.')

/** The numbers a card may say: the finding's own (and their roundings), the slice's, the dates and the wait. */
export function allowedNumbers(f: Finding): Set<string> {
  const { need, days } = needMore(f)
  const out = new Set<string>()
  const add = (x: number | string) => {
    out.add(canon(String(x)))
    if (typeof x === 'number' && !Number.isInteger(x)) out.add(String(Math.round(x)))
  }
  for (const x of [
    f.gap.a.k,
    f.gap.a.n,
    f.gap.b.k,
    f.gap.b.n,
    f.gap.pa,
    f.gap.pb,
    Math.abs(f.gap.diffPp),
    need,
    days,
    need - Math.min(f.gap.a.n, f.gap.b.n),
    5,
    30,
  ])
    add(x)
  for (const m of `${f.group} ${fmtDay(f.from)} ${fmtDay(f.to)}`.match(num) ?? []) add(m)
  return out
}

/** Whether every number in the model's words is one of the finding's: a number the code did not count is not said. */
export function numbersOk(text: string, f: Finding): boolean {
  const allowed = allowedNumbers(f)
  return (text.match(num) ?? []).every((n) => allowed.has(canon(n)))
}

/** The same card without the model: plain words made of the facts (used when the model's text does not pass). */
export function plainText(f: Finding): string {
  const { need, days } = needMore(f)
  const g = f.gap
  const h = DIM_HINT[f.dim]
  return [
    `Заметила: ${OUTCOME_RU[f.outcome]}, ${f.group}: ${g.a.k} из ${g.a.n} (${g.pa}%) против ${g.b.k} из ${g.b.n} (${g.pb}%) у остальных.`,
    `Почему так может быть: ${h.mechanism}.`,
    `Что проверить: ${h.check}. Результат поймём по той же доле; ждать примерно ${days} дн., пока в группе наберётся около ${need} случаев.`,
  ].join('\n')
}

/** The line the code adds under every card, so the numbers can be checked: the model has no say in it. */
export function footer(f: Finding): string {
  const g = f.gap
  const { need, days } = needMore(f)
  const more =
    f.level === 'early'
      ? ` До проверки нужно ещё около ${Math.max(0, need - Math.min(g.a.n, g.b.n))} случаев в группе (примерно ${days} дн.).`
      : ''
  return [
    `Цифры: ${g.a.k} из ${g.a.n} (${g.pa}%) против ${g.b.k} из ${g.b.n} (${g.pb}%), разница ${sign(g.diffPp)} п.п., вероятность случайности ${g.p < 0.001 ? 'меньше 0,1%' : `${(g.p * 100).toFixed(1).replace('.', ',')}%`}.`,
    `Данные: ${f.source}, ${fmtDay(f.from)}-${fmtDay(f.to)}, ${g.a.n + g.b.n} наблюдений.${more}`,
  ].join('\n')
}

export function renderCard(f: Finding, modelText: string | null): { text: string; model: boolean } {
  const ok = modelText !== null && numbersOk(modelText, f)
  const body = (ok ? modelText : plainText(f)).trim()
  const top =
    f.level === 'conclusion'
      ? '📊 Вывод'
      : '📊 Ранний сигнал (данных мало, это гипотеза, а не вывод)'
  return { text: `${top}\n\n${body}\n\n${footer(f)}`, model: ok }
}
