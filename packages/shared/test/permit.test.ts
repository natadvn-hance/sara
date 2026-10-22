import { expect, it } from 'vitest'
import { signPermit, verifyPermit } from '../src/permit'

it('C2: permit verifies only for its own key', () => {
  const p = signPermit('s', 'bid:123')
  expect(verifyPermit('s', 'bid:123', p)).toBe(true)
  expect(verifyPermit('s', 'bid:124', p)).toBe(false)
  expect(verifyPermit('other', 'bid:123', p)).toBe(false)
})
