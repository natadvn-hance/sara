import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ProfiOrder } from '@sara/shared'

const DIR = resolve(import.meta.dirname, '../../../../tests/fixtures/orders')

export function sampleOrders(): ProfiOrder[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ProfiOrder.parse(JSON.parse(readFileSync(join(DIR, f), 'utf8'))))
}
