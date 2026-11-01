import { parsePriceRange, priceRange } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { priceOf, priceToWithin } from '../src/leads/draft'

describe('the price range of a bid (Boris, 31.10.2026: «резонный диапазон, как у старой Сары»)', () => {
  it('FR-LEAD-6: a range is read the way Boris writes it', () => {
    expect(parsePriceRange('30 000 - 60 000')).toEqual({ from: 30000, to: 60000 })
    expect(parsePriceRange('от 30 до 60 тыс.')).toEqual({ from: 30000, to: 60000 })
    expect(parsePriceRange('30-60к')).toEqual({ from: 30000, to: 60000 })
    expect(parsePriceRange('45000')).toEqual({ from: 45000, to: null })
    expect(parsePriceRange('60 000 - 30 000')).toEqual({ from: 30000, to: 60000 })
    expect(parsePriceRange('пять тысяч')).toBeNull()
  })

  it('FR-LEAD-6: «до» is the Analyst’s own when it stands over «от», half again over «от» otherwise', () => {
    expect(priceRange(40000, 90000)).toEqual({ from: 40000, to: 90000 })
    expect(priceRange(40000, null)).toEqual({ from: 40000, to: 60000 })
    expect(priceRange(40000, 30000)).toEqual({ from: 40000, to: 60000 })
    expect(priceRange(40000, 40000)).toEqual({ from: 40000, to: 60000 })
  })

  it('FR-LEAD-6: «до» does not pass the client’s budget, and an unusable one falls back', () => {
    expect(priceToWithin(30000, 90000, null)).toBe(90000)
    expect(priceToWithin(30000, 90000, 'до 60 000 ₽')).toBe(60000)
    expect(priceToWithin(30000, 90000, 'от 20 000 до 50 000 ₽')).toBe(50000)
    expect(priceToWithin(30000, 90000, '30 000')).toBeNull()
    expect(priceToWithin(30000, null, null)).toBeNull()
    expect(priceToWithin(null, 90000, null)).toBeNull()
  })

  it('FR-LEAD-6: Boris’s answer after «Изменить» may be a range on a line of its own', () => {
    expect(priceOf('Сделаем.\n30 000 - 60 000 ₽')).toEqual({
      text: 'Сделаем.',
      priceRub: 30000,
      priceToRub: 60000,
    })
    expect(priceOf('цена от 30 до 60 тыс.')).toEqual({
      text: null,
      priceRub: 30000,
      priceToRub: 60000,
    })
    expect(priceOf('30-60к')).toEqual({ text: null, priceRub: 30000, priceToRub: 60000 })
    // A date or a count of days is text.
    expect(priceOf('Сделаем за 10-12 дней').priceRub).toBeNull()
    expect(priceOf('10-12').priceRub).toBeNull()
    // The answer to the price question may be a bare range.
    expect(priceOf('30 000 - 60 000', { bare: true })).toEqual({
      text: null,
      priceRub: 30000,
      priceToRub: 60000,
    })
    expect(priceOf('45000', { bare: true })).toEqual({
      text: null,
      priceRub: 45000,
      priceToRub: null,
    })
  })
})
