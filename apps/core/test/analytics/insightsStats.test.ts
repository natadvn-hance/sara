import { describe, expect, it } from 'vitest'
import { footer, numbersOk, plainText, renderCard } from '../../src/analytics/insights/card'
import {
  type BidFeature,
  bidFindings,
  type Finding,
  pickFindings,
  streamFindings,
} from '../../src/analytics/insights/findings'
import { casesNeeded, fisherP, gap, levelOf } from '../../src/analytics/insights/stats'

const bid = (o: Partial<BidFeature> = {}): BidFeature => ({
  bidAt: '2026-10-28T09:00:00Z',
  delayMin: 20,
  priceRub: 8000,
  score: 60,
  service: 'Сайт',
  hour: 12,
  series: false,
  replied: false,
  opened: true,
  negotiated: null,
  ...o,
})

describe('thresholds of the analytics hypotheses', () => {
  it("FR-ANL: Boris's own example, 5 of 14 against 26 of 79, is no signal at all", () => {
    const g = gap({ k: 5, n: 14 }, { k: 26, n: 79 })
    expect(g.pa).toBe(35.7)
    expect(g.pb).toBe(32.9)
    expect(levelOf(g, 'bids')).toBeNull()
  })

  it('FR-ANL: a big gap on few cases is an early signal, on enough cases with a small chance of luck a conclusion', () => {
    expect(levelOf(gap({ k: 9, n: 10 }, { k: 20, n: 70 }), 'bids')).toBe('early')
    expect(levelOf(gap({ k: 30, n: 40 }, { k: 20, n: 60 }), 'bids')).toBe('conclusion')
  })

  it('FR-ANL: under eight cases in a group nothing is said, however big the gap', () => {
    expect(levelOf(gap({ k: 7, n: 7 }, { k: 0, n: 70 }), 'bids')).toBeNull()
  })

  it('FR-ANL: a gap of 20 points is no early signal (25 are needed) and is a conclusion only with the test passing', () => {
    expect(levelOf(gap({ k: 12, n: 20 }, { k: 20, n: 80 }), 'bids')).toBe('conclusion')
    expect(levelOf(gap({ k: 8, n: 10 }, { k: 40, n: 70 }), 'bids')).toBeNull()
  })

  it('FR-ANL: a stream of orders needs far more cases than the bids do', () => {
    const g = gap({ k: 40, n: 100 }, { k: 20, n: 100 })
    expect(levelOf(g, 'bids')).toBe('conclusion')
    expect(levelOf(g, 'stream')).toBeNull()
    expect(levelOf(gap({ k: 400, n: 1000 }, { k: 250, n: 1000 }), 'stream')).toBe('conclusion')
  })

  it('FR-ANL: the exact test of Fisher matches the known value', () => {
    // [[3,1],[1,3]]: the classic two-sided p = 0.4857
    expect(fisherP({ k: 3, n: 4 }, { k: 1, n: 4 })).toBeCloseTo(0.4857, 3)
    expect(fisherP({ k: 0, n: 0 }, { k: 1, n: 4 })).toBe(1)
  })

  it('FR-ANL: more cases are always needed than the group has', () => {
    expect(casesNeeded(60, 30, 10)).toBeGreaterThan(10)
    expect(casesNeeded(30, 30, 10)).toBe(1000)
  })
})

describe('findings from the bids', () => {
  it('FR-ANL: nothing to say on no bids, or on bids that do not differ', () => {
    expect(bidFindings([])).toEqual([])
    const flat = Array.from({ length: 60 }, (_, i) =>
      bid({ replied: i % 3 === 0, hour: 10 + (i % 3) }),
    )
    expect(bidFindings(flat)).toEqual([])
  })

  it('FR-ANL: a quick bid that gets answers far more often shows up as an early signal with its numbers', () => {
    const fast = Array.from({ length: 10 }, (_, i) => bid({ delayMin: 3, replied: i < 8 }))
    const slow = Array.from({ length: 40 }, (_, i) => bid({ delayMin: 300, replied: i < 8 }))
    const f = bidFindings([...fast, ...slow]).find(
      (x) => x.dim === 'delay' && x.outcome === 'replied' && x.group.includes('5 минут'),
    )
    expect(f?.level).toBe('early')
    expect(f?.gap).toMatchObject({ a: { k: 8, n: 10 }, b: { k: 8, n: 40 } })
    expect(f?.fingerprint).toBe('replied|delay|отклик за 5 минут и быстрее|+')
  })

  it('FR-ANL: a funnel stage is not judged while the stages cannot be trusted (null)', () => {
    const rows = Array.from({ length: 60 }, (_, i) => bid({ delayMin: i < 30 ? 3 : 300 }))
    expect(bidFindings(rows).some((f) => f.outcome === 'negotiated')).toBe(false)
  })

  it('FR-ANL: the stream says nothing on a small flow and speaks on a large, uneven one', () => {
    const calm = Array.from({ length: 100 }, () => ({ category: 'Сайты', hour: 12, lateMin: 3 }))
    expect(streamFindings(calm, '2026-10-01', '2026-10-30')).toEqual([])
    const uneven = [
      ...Array.from({ length: 600 }, (_, i) => ({
        category: 'Сайты',
        hour: 12,
        lateMin: i < 300 ? 9 : 2,
      })),
      ...Array.from({ length: 600 }, (_, i) => ({
        category: 'SEO',
        hour: 12,
        lateMin: i < 60 ? 9 : 2,
      })),
    ]
    const f = streamFindings(uneven, '2026-10-01', '2026-10-30')
    expect(f.some((x) => x.group.includes('Сайты') && x.level === 'conclusion')).toBe(true)
  })
})

const make = (o: Partial<Finding> & Pick<Finding, 'fingerprint'>): Finding => ({
  level: 'early',
  flow: 'bids',
  outcome: 'replied',
  dim: 'delay',
  group: 'отклик за 5 минут и быстрее',
  gap: gap({ k: 8, n: 10 }, { k: 8, n: 40 }),
  from: '2026-10-24',
  to: '2026-10-30',
  source: 'отклики Сары',
  ...o,
})

describe('which findings are told', () => {
  it('FR-ANL: the same hypothesis is never told twice, a silenced one not even grown into a conclusion', () => {
    const a = make({ fingerprint: 'a' })
    const told = new Map([['a', { level: 'early' as const, silenced: false }]])
    expect(pickFindings([a], told)).toEqual([])
    const up = make({ fingerprint: 'a', level: 'conclusion' })
    expect(pickFindings([up], told)).toEqual([up])
    expect(
      pickFindings([up], new Map([['a', { level: 'early' as const, silenced: true }]])),
    ).toEqual([])
  })

  it('FR-ANL: at most two a day and one per kind of slice, conclusions first', () => {
    const rows = [
      make({ fingerprint: 'd1', dim: 'delay' }),
      make({ fingerprint: 'd2', dim: 'delay', level: 'conclusion' }),
      make({ fingerprint: 'p1', dim: 'price' }),
      make({ fingerprint: 's1', dim: 'score' }),
    ]
    const out = pickFindings(rows, new Map())
    expect(out).toHaveLength(2)
    expect(out[0]?.fingerprint).toBe('d2')
    expect(new Set(out.map((f) => f.dim)).size).toBe(2)
  })

  it('FR-ANL: silence when there is nothing to tell', () => {
    expect(pickFindings([], new Map())).toEqual([])
  })
})

describe('the card', () => {
  const f = make({ fingerprint: 'x' })

  it("FR-ANL: an early signal says it is a guess and how many cases it still needs; the numbers are the code's", () => {
    const c = renderCard(f, null)
    expect(c.model).toBe(false)
    expect(c.text).toContain('данных мало, это гипотеза, а не вывод')
    expect(c.text).toContain('8 из 10 (80%) против 8 из 40 (20%)')
    expect(c.text).toContain('До проверки нужно ещё около')
    expect(c.text).toContain('24.10-30.10')
  })

  it('FR-ANL: a conclusion carries no apology', () => {
    const c = renderCard(make({ fingerprint: 'y', level: 'conclusion' }), null)
    expect(c.text.startsWith('📊 Вывод')).toBe(true)
    expect(c.text).not.toContain('гипотеза, а не вывод')
  })

  it('FR-ANL: the words of the model with a number the code did not count are not used', () => {
    const good =
      'Заметила: 8 из 10 против 8 из 40. Почему так может быть: догадка. Что проверить: быстрее.'
    const bad = 'Заметила: 9 из 10 против 8 из 40, ответили почти все.'
    expect(numbersOk(good, f)).toBe(true)
    expect(numbersOk(bad, f)).toBe(false)
    expect(renderCard(f, good).model).toBe(true)
    const r = renderCard(f, bad)
    expect(r.model).toBe(false)
    expect(r.text).not.toContain('9 из 10')
  })

  it('FR-ANL: no card holds a long dash', () => {
    expect(renderCard(f, null).text).not.toContain('—')
    expect(plainText(f)).not.toContain('—')
    expect(footer(f)).not.toContain('—')
  })
})
