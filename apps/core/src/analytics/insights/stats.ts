/**
 * The numbers behind a hypothesis of the «📊 Аналитика» topic (docs/product/analytics-hypotheses.md): a share against
 * a share, and whether the gap is big enough, from enough cases, to be said out loud. The model never counts.
 */

export type Group = { k: number; n: number }

export type Gap = {
  a: Group
  b: Group
  /** Shares in percent, one decimal. */
  pa: number
  pb: number
  /** a minus b, percentage points. */
  diffPp: number
  /** Two-sided exact test of Fisher; 1 when a group is empty. */
  p: number
}

export const pct = (k: number, n: number): number => (n > 0 ? Math.round((k / n) * 1000) / 10 : 0)

const logFact: number[] = [0]
function lf(n: number): number {
  for (let i = logFact.length; i <= n; i++) logFact[i] = (logFact[i - 1] ?? 0) + Math.log(i)
  return logFact[n] ?? 0
}

/** Probability of the table [[a, b - a], [c, d - c]] given its margins (hypergeometric). */
function tableP(a: number, n1: number, c: number, n2: number): number {
  const k = a + c
  const n = n1 + n2
  return Math.exp(
    lf(n1) + lf(n2) + lf(k) + lf(n - k) - lf(n) - lf(a) - lf(n1 - a) - lf(c) - lf(n2 - c),
  )
}

/** Fisher's exact test, two-sided: the sum of every table as unlikely as the one seen or less. */
export function fisherP(a: Group, b: Group): number {
  const n1 = a.n
  const n2 = b.n
  const k = a.k + b.k
  if (n1 === 0 || n2 === 0) return 1
  const seen = tableP(a.k, n1, b.k, n2)
  let p = 0
  for (let x = Math.max(0, k - n2); x <= Math.min(n1, k); x++) {
    const px = tableP(x, n1, k - x, n2)
    if (px <= seen * (1 + 1e-9)) p += px
  }
  return Math.min(1, p)
}

export function gap(a: Group, b: Group): Gap {
  const pa = pct(a.k, a.n)
  const pb = pct(b.k, b.n)
  return { a, b, pa, pb, diffPp: Math.round((pa - pb) * 10) / 10, p: fisherP(a, b) }
}

/**
 * Two levels (Boris, 01.11.2026). «Вывод»: enough cases in both groups, a big gap and a test that says it is not chance.
 * «Ранний сигнал»: few cases, a very big gap, said as a guess. A stream of orders (thousands a week) uses the usual test
 * with its own sizes and has no early level; a small flow like the bids (around eighty) would stay silent under them.
 */
export type Level = 'conclusion' | 'early'
export type Flow = 'bids' | 'stream'

export const THRESHOLDS = {
  bids: { conclusion: { n: 20, pp: 15, p: 0.1 }, early: { n: 8, pp: 25 } },
  /** A stream has enough cases for a real test, so it has no early level: it is a conclusion or silence. */
  stream: { conclusion: { n: 200, pp: 10, p: 0.05 }, early: null },
} as const

export function levelOf(g: Gap, flow: Flow): Level | null {
  const t = THRESHOLDS[flow]
  const small = Math.min(g.a.n, g.b.n)
  const big = Math.abs(g.diffPp)
  if (small >= t.conclusion.n && big >= t.conclusion.pp && g.p < t.conclusion.p) return 'conclusion'
  if (t.early && small >= t.early.n && big >= t.early.pp) return 'early'
  return null
}

/**
 * How many cases each group needs for this gap to pass the test of a conclusion, with the usual 80% power (two shares,
 * normal approximation); the number said to Boris under an early signal. Capped, never below what the groups have.
 */
export function casesNeeded(pa: number, pb: number, have: number): number {
  const p1 = pa / 100
  const p2 = pb / 100
  const d = Math.abs(p1 - p2)
  if (d < 0.01) return 1000
  const z = 1.645 + 0.842
  const pbar = (p1 + p2) / 2
  const n = Math.ceil(((z * Math.sqrt(2 * pbar * (1 - pbar))) / d) ** 2)
  return Math.min(1000, Math.max(n, have + 1))
}
