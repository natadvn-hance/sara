import {
  type DirectionRules,
  LEAD_KIND_TITLES,
  LEAD_KINDS,
  type ProfiOrder,
  ScorerOutput,
  thresholdFor,
  weightedScore,
} from '@sara/shared'
import type { Gateway } from '../gateway/gateway'
import { type Precedent, precedentsText } from '../learning/precedents'
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
export function rulesText(r: DirectionRules, category?: string): string {
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
  lines.push('', thresholdLine(r, category))
  return lines.join('\n')
}

/** The threshold line: the one of the order's kind, or all of them when there is no order (a proposal, advice). */
function thresholdLine(r: DirectionRules, category?: string): string {
  if (!r.kind_thresholds) return `Порог: ${r.threshold}`
  if (category !== undefined) return `Порог: ${thresholdFor(r, category)}`
  const by = LEAD_KINDS.map(
    (k) => `${LEAD_KIND_TITLES[k]} ${r.kind_thresholds?.[k] ?? r.threshold}`,
  )
  return `Порог: ${r.threshold} (по видам заказа: ${by.join(', ')})`
}

/**
 * What the Scorer sees: the rules, then the order, then Boris's own decisions on similar orders (07.11.2026), if any.
 * No client's name is put in it, and one inside a text or a title is hidden by the gateway (ADR-016).
 */
export function scorerInput(
  o: ProfiOrder,
  rules: DirectionRules,
  precedents: Precedent[] = [],
  minSimilar?: number,
): string {
  const past = precedentsText(precedents, minSimilar)
  return `${rulesText(rules, o.category)}\n\nЗаказ\n\n${sorterInput(o)}${past ? `\n\n${past}` : ''}`
}

/** The total and the decision are the code's: weights stay data, one set of axis scores gives one result. */
export function decide(
  rules: DirectionRules,
  out: ScorerOutput,
  category?: string,
): { score: number; decision: 'show' | 'drop' } {
  const score = weightedScore(rules, Object.fromEntries(out.axes.map((a) => [a.id, a.score])))
  return {
    score,
    decision: !out.stop_factor && score >= thresholdFor(rules, category) ? 'show' : 'drop',
  }
}

/** An answer that names a stop factor or axes the rules do not have is not a score. */
function fits(rules: DirectionRules, out: ScorerOutput): boolean {
  if (out.stop_factor && !rules.stop_factors.some((s) => s.id === out.stop_factor)) return false
  const ids = out.axes.map((a) => a.id).sort()
  const want = rules.axes.map((a) => a.id).sort()
  return ids.length === want.length && ids.every((id, i) => id === want[i])
}

/** Near the threshold or unsure: such a score is redone on the stronger model. */
const borderline = (rules: DirectionRules, score: number, confidence: number, category: string) =>
  Math.abs(score - thresholdFor(rules, category)) <= 10 || confidence < 0.6

export async function scoreOrder(
  gw: Gateway,
  o: ProfiOrder,
  rules: DirectionRules,
  opts: {
    escalate?: boolean
    correlationId?: string
    causationId?: string
    /** Trial runs pass P3 so a live order is never scored behind them. */
    priority?: 'P0' | 'P1' | 'P2' | 'P3'
    /** Told why a model call gave no answer (for example `limit_reached`), before the score is a miss. */
    onFailure?: (errorClass: string) => void
    /** Boris's decisions on similar orders; a backtest and a trial leave them out, they compare rules alone. */
    precedents?: Precedent[]
    /** From how many similar decisions their share counts (`autobid.min_similar`), as on the card. */
    minSimilar?: number
  } = {},
): Promise<Scored | null> {
  const precedents = opts.precedents ?? []
  const input = scorerInput(o, rules, precedents, opts.minSimilar)
  const once = async (model: 'haiku' | 'sonnet'): Promise<Scored | null> => {
    const r = await gw.call('scorer', input, ScorerOutput, {
      model,
      priority: opts.priority,
      correlationId: opts.correlationId,
      causationId: opts.causationId,
      redact: { names: namesToHide(o.client_name, ...precedents.map((p) => p.clientName)) },
    })
    if (!r.ok) opts.onFailure?.(r.errorClass)
    if (!r.ok || !fits(rules, r.output)) return null
    return {
      ...decide(rules, r.output, o.category),
      stopFactor: r.output.stop_factor,
      redFlags: r.output.red_flags,
      axes: r.output.axes,
      reason: r.output.reason,
      confidence: r.output.confidence,
      model,
    }
  }
  const first = await once('haiku')
  const doubt = !first || borderline(rules, first.score, first.confidence, o.category)
  if (opts.escalate === false || !doubt) return first
  // The stronger model decides when it answers; a failed retry keeps haiku's score.
  return (await once('sonnet')) ?? first
}
