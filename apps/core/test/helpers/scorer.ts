import type { ScorerOutput } from '@sara/shared'
import { RULES_V1 } from '../../src/direction/v1'

/** A Scorer answer whose five axes all score `v`, so the weighted score is `v`. */
export function scorerAnswer(v: number, over: Partial<ScorerOutput> = {}): ScorerOutput {
  return {
    stop_factor: null,
    red_flags: [],
    axes: RULES_V1.axes.map((a) => ({ id: a.id, score: v, why: 'так' })),
    reason: 'Зрелый бизнес, понятная задача',
    confidence: 0.9,
    ...over,
  }
}
