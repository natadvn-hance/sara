import { describe, expect, it } from 'vitest'
import { summarizeEval } from '../src/leads/scoreEval'

describe('Scorer check on old leads', () => {
  it("FR-LEAD-3: agreement counts old Sara's respond/skip against show/drop, and dropped responded leads", () => {
    const s = summarizeEval([
      { id: '1', sets: ['responded'], oldDecision: 'respond', decision: 'show' },
      { id: '2', sets: ['responded'], oldDecision: 'respond', decision: 'drop' },
      { id: '3', sets: ['old_skip'], oldDecision: 'skip', decision: 'drop' },
      { id: '4', sets: ['snippet_skip'], oldDecision: null, decision: 'show' },
      { id: '5', sets: ['old_respond'], oldDecision: 'respond', decision: null },
    ])
    expect(s).toMatchObject({
      scored: 4,
      failed: 1,
      comparable: 3,
      agreement: 2 / 3,
      respondedDropped: 1,
      bySet: {
        responded: { show: 1, drop: 1 },
        old_skip: { show: 0, drop: 1 },
        snippet_skip: { show: 1, drop: 0 },
      },
    })
  })
})
