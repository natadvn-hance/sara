import { expect, it } from 'vitest'
import { formatRub } from '../src/index'

it('NFR-UX-1: formatRub uses a no-break space', () => {
  expect(formatRub(1250)).toBe('1 250 ₽')
  expect(formatRub(210)).toBe('210 ₽')
})
