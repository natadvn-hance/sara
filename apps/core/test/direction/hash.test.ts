import { describe, expect, it } from 'vitest'
import { canonicalJson, rulesHash } from '../../src/direction/hash'
import { RULES_V1 } from '../../src/direction/v1'

describe('rules hash', () => {
  it('FR-ACC-5: the same rules in another key order have the same hash', () => {
    const shuffled = Object.fromEntries(Object.entries(RULES_V1).reverse()) as typeof RULES_V1
    expect(rulesHash(shuffled)).toBe(rulesHash(RULES_V1))
    expect(rulesHash(RULES_V1)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('FR-ACC-5: other rules have another hash, and so does a changed order of a list', () => {
    expect(rulesHash({ ...RULES_V1, threshold: 57 })).not.toBe(rulesHash(RULES_V1))
    const axes = [...RULES_V1.axes].reverse()
    expect(rulesHash({ ...RULES_V1, axes })).not.toBe(rulesHash(RULES_V1))
  })

  it('FR-ACC-5: canonical JSON sorts object keys at every depth and keeps arrays as they are', () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}')
  })
})
