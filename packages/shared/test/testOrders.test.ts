import { describe, expect, it } from 'vitest'
import { isTestOrder, shownTitle, TEST_ORDER_SQL } from '../src/testOrders'

describe('test orders', () => {
  it('FR-LEAD-9: only eleven digits from 99 are a test order, never a number Profi.ru gives', () => {
    expect(isTestOrder('99000000001')).toBe(true)
    for (const real of [
      '95147898',
      '99147898',
      '9900000001',
      '990000000011',
      '89000000001',
      ' 99000000001',
    ])
      expect(isTestOrder(real)).toBe(false)
    expect(isTestOrder(null)).toBe(false)
    expect(new RegExp(TEST_ORDER_SQL).test('99000000001')).toBe(true)
    expect(new RegExp(TEST_ORDER_SQL).test('95147898')).toBe(false)
  })

  it('NFR-UX-1: a test order is marked wherever its title is shown, a real one is not', () => {
    expect(shownTitle('99000000001', 'Сайт для клиники')).toBe('🧪 Тест · Сайт для клиники')
    expect(shownTitle('95147898', 'Сайт для клиники')).toBe('Сайт для клиники')
  })
})
