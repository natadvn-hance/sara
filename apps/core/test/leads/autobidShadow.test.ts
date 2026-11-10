import { describe, expect, it } from 'vitest'
import { shadowPayload, wouldBid } from '../../src/leads/autobidShadow'

const RULE = { minSimilar: 10, minSharePct: 80, maxFeeRub: 200 }
const FRESH = { rub: 150, fromPage: true }

describe('the shadow of the auto-bid (Boris, 10.11.2026)', () => {
  it('FR-LEAD-9: more than 80% bids on ten or more similar orders and a fresh price of 200 ₽ or less: Sara would bid', () => {
    expect(wouldBid({ n: 10, bid: 9 }, FRESH, RULE)).toEqual({ would: true, misses: [] })
    expect(wouldBid({ n: 15, bid: 13 }, { rub: 200, fromPage: true }, RULE).would).toBe(true)
  })

  it('FR-LEAD-9: «больше 80%» is strict: 8 of 10 is not enough, whatever the rounding', () => {
    expect(wouldBid({ n: 10, bid: 8 }, FRESH, RULE)).toEqual({
      would: false,
      misses: ['low_share'],
    })
    // 12 of 15 is 80% too; 13 of 15 is 86.7%.
    expect(wouldBid({ n: 15, bid: 12 }, FRESH, RULE).misses).toEqual(['low_share'])
  })

  it('FR-LEAD-9: too few similar orders, an unknown, old or dear price: no, and each reason is a code', () => {
    expect(wouldBid({ n: 9, bid: 9 }, FRESH, RULE).misses).toEqual(['few_similar'])
    expect(wouldBid(null, FRESH, RULE).misses).toEqual(['few_similar', 'low_share'])
    expect(wouldBid({ n: 10, bid: 10 }, { rub: 0, fromPage: true }, RULE).misses).toEqual([
      'fee_unknown',
    ])
    // A price that did not come from the order page just now may be the first, higher one (110 → 55 → 1 ₽).
    expect(wouldBid({ n: 10, bid: 10 }, { rub: 150, fromPage: false }, RULE).misses).toEqual([
      'fee_not_fresh',
    ])
    expect(wouldBid({ n: 10, bid: 10 }, { rub: 210, fromPage: true }, RULE).misses).toEqual([
      'fee_high',
    ])
    expect(wouldBid({ n: 3, bid: 1 }, { rub: 900, fromPage: false }, RULE).misses).toEqual([
      'few_similar',
      'low_share',
      'fee_not_fresh',
      'fee_high',
    ])
  })

  it('FR-LEAD-9: the thresholds are Boris’s: no ceiling, a lower share or minimum change the answer', () => {
    const r = { minSimilar: 5, minSharePct: 60, maxFeeRub: null }
    expect(wouldBid({ n: 5, bid: 4 }, { rub: 900, fromPage: true }, r).would).toBe(true)
  })

  it('FR-LEAD-9: the journal keeps numbers and flags only (ADR-016)', () => {
    expect(shadowPayload({ n: 10, bid: 9 }, { rub: 0, fromPage: false }, RULE)).toEqual({
      would: false,
      misses: ['fee_unknown'],
      n: 10,
      bid: 9,
      fee_rub: null,
      fee_from_page: false,
      min_similar: 10,
      min_share_pct: 80,
      max_fee_rub: 200,
    })
  })
})
