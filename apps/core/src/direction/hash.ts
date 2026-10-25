import { createHash } from 'node:crypto'
import type { DirectionRules } from '@sara/shared'

/** JSON with the keys of every object sorted, so equal data is equal text; arrays keep their order. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  )
}

/** What a trial score is cached under: the rules themselves, whatever order their keys were written in. */
export function rulesHash(rules: DirectionRules): string {
  return createHash('sha256').update(canonicalJson(rules)).digest('hex')
}
