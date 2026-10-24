import { describe, expect, it } from 'vitest'
import { isStale } from '../src/leads/cardFlow'

const NOW = new Date('2026-10-25T12:00:00Z')

describe('card flow', () => {
  it('FR-LEAD-10: an order published over 24 hours ago is stale', () => {
    expect(isStale('2026-10-24T11:59:00Z', NOW)).toBe(true)
    expect(isStale('2026-10-24T12:01:00Z', NOW)).toBe(false)
  })

  it('FR-LEAD-10: an order without a publication time is never stale', () => {
    expect(isStale(null, NOW)).toBe(false)
    expect(isStale(undefined, NOW)).toBe(false)
  })
})
