export type EvalRow = {
  id: string
  sets: string[]
  /** Old Sara's analyzer decision, null when she skipped the order on its feed line alone. */
  oldDecision: 'respond' | 'skip' | null
  /** The Scorer's decision under the rules being checked, null when it did not answer. */
  decision: 'show' | 'drop' | null
}

/** How the Scorer's decisions on old Sara's leads compare with hers (the check before turning sorting on). */
export function summarizeEval(rows: EvalRow[]) {
  const scored = rows.filter((r) => r.decision !== null)
  const comparable = scored.filter((r) => r.oldDecision !== null)
  const agree = comparable.filter(
    (r) => (r.oldDecision === 'respond') === (r.decision === 'show'),
  ).length
  const bySet: Record<string, { show: number; drop: number }> = {}
  for (const r of scored) {
    for (const s of r.sets) {
      const b = bySet[s] ?? { show: 0, drop: 0 }
      bySet[s] = b
      if (r.decision === 'show') b.show++
      else b.drop++
    }
  }
  return {
    scored: scored.length,
    failed: rows.length - scored.length,
    comparable: comparable.length,
    agreement: comparable.length > 0 ? agree / comparable.length : 0,
    respondedDropped: scored.filter((r) => r.sets.includes('responded') && r.decision === 'drop')
      .length,
    bySet,
  }
}
