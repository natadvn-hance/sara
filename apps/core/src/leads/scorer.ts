import { type DirectionRules, type ProfiOrder, ScorerOutput, weightedScore } from '@sara/shared'
import type { Gateway } from '../gateway/gateway'
import { namesToHide } from './clientName'
import { sorterInput } from './sorter'

export type Scored = {
  score: number
  decision: 'show' | 'drop'
  stopFactor: string | null
  redFlags: string[]
  axes: ScorerOutput['axes']
  reason: string
  confidence: number
  model: 'haiku' | 'sonnet'
}

/** The direction rules as the model reads them, section by section. */
export function rulesText(r: DirectionRules): string {
  const lines = [
    'Правила направления',
    '',
    `О нас: ${r.about}`,
    '',
    'Стоп-факторы (заказ не берём):',
  ]
  for (const s of r.stop_factors) {
    lines.push(`- ${s.id}: ${s.text}`)
    if (s.exception) lines.push(`  Исключение: ${s.exception}`)
    if (s.examples.length > 0) lines.push(`  Примеры: ${s.examples.join('; ')}`)
  }
  lines.push('', 'Красные флаги:')
  for (const f of r.red_flags) lines.push(`- ${f.id}${f.soft ? ' (мягкий)' : ''}: ${f.text}`)
  lines.push('', 'Оси оценки (балл 0-100 по каждой):')
  for (const a of r.axes) lines.push(`- ${a.id}, ${a.title}, вес ${a.weight}%: ${a.how}`)
  if (r.notes.length > 0) {
    lines.push('', 'Уточнения:')
    for (const n of r.notes) lines.push(`- ${n}`)
  }
  lines.push('', `Порог: ${r.threshold}`)
  return lines.join('\n')
}

/** What the Scorer sees: the rules, then the order. The client's name is never put in it, and one inside the text is hidden by the gateway (ADR-016). */
export function scorerInput(o: ProfiOrder, rules: DirectionRules): string {
  return `${rulesText(rules)}\n\nЗаказ\n\n${sorterInput(o)}`
}

/** The total and the decision are the code's: weights stay data, one set of axis scores gives one result. */
export function decide(
  rules: DirectionRules,
  out: ScorerOutput,
): { score: number; decision: 'show' | 'drop' } {
  const score = weightedScore(rules, Object.fromEntries(out.axes.map((a) => [a.id, a.score])))
  return { score, decision: !out.stop_factor && score >= rules.threshold ? 'show' : 'drop' }
}

/** An answer that names a stop factor or axes the rules do not have is not a score. */
function fits(rules: DirectionRules, out: ScorerOutput): boolean {
  if (out.stop_factor && !rules.stop_factors.some((s) => s.id === out.stop_factor)) return false
  const ids = out.axes.map((a) => a.id).sort()
  const want = rules.axes.map((a) => a.id).sort()
  return ids.length === want.length && ids.every((id, i) => id === want[i])
}

/** Near the threshold or unsure: such a score is redone on the stronger model. */
const borderline = (rules: DirectionRules, score: number, confidence: number) =>
  Math.abs(score - rules.threshold) <= 10 || confidence < 0.6

export async function scoreOrder(
  gw: Gateway,
  o: ProfiOrder,
  rules: DirectionRules,
  opts: { escalate?: boolean; correlationId?: string; causationId?: string } = {},
): Promise<Scored | null> {
  const input = scorerInput(o, rules)
  const once = async (model: 'haiku' | 'sonnet'): Promise<Scored | null> => {
    const r = await gw.call('scorer', input, ScorerOutput, {
      model,
      correlationId: opts.correlationId,
      causationId: opts.causationId,
      redact: { names: namesToHide(o.client_name) },
    })
    if (!r.ok || !fits(rules, r.output)) return null
    return {
      ...decide(rules, r.output),
      stopFactor: r.output.stop_factor,
      redFlags: r.output.red_flags,
      axes: r.output.axes,
      reason: r.output.reason,
      confidence: r.output.confidence,
      model,
    }
  }
  const first = await once('haiku')
  const doubt = !first || borderline(rules, first.score, first.confidence)
  if (opts.escalate === false || !doubt) return first
  // The stronger model decides when it answers; a failed retry keeps haiku's score.
  return (await once('sonnet')) ?? first
}
