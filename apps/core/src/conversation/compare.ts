import { normalizeText } from '@sara/shared'

const trigrams = (s: string): Set<string> => {
  const t = normalizeText(s)
  const out = new Set<string>()
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
  return out
}

/**
 * How alike two texts are, 0..100: three-letter pieces after normalizeText, Jaccard (M4 plan, Task C4; M5 uses it
 * for Boris's edits). Texts too short for a piece («Да», «Не») are the same only when they are equal.
 */
export function similarity(a: string, b: string): number {
  const x = trigrams(a)
  const y = trigrams(b)
  if (x.size === 0 && y.size === 0) return normalizeText(a) === normalizeText(b) ? 100 : 0
  let both = 0
  for (const g of x) if (y.has(g)) both++
  return Math.round((100 * both) / (x.size + y.size - both))
}
