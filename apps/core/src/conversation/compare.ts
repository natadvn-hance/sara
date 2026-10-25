import { normalizeText } from '@sara/shared'

const trigrams = (s: string): Set<string> => {
  const t = normalizeText(s)
  const out = new Set<string>()
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
  return out
}

/**
 * How alike two texts are, 0..100: three-letter pieces after normalizeText, Jaccard (M4 plan, Task C4; M5 uses it
 * for Boris's edits). Two empty texts are the same.
 */
export function similarity(a: string, b: string): number {
  const x = trigrams(a)
  const y = trigrams(b)
  if (x.size === 0 && y.size === 0) return 100
  let both = 0
  for (const g of x) if (y.has(g)) both++
  return Math.round((100 * both) / (x.size + y.size - both))
}
