import { TEST_ORDER_SQL } from '@sara/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

/**
 * A real order or chat, not a test one: test orders stay out of the money of the day, the card cap, the summaries,
 * the analytics and the learning (docs/ops/test-leads.md).
 */
export const notTest = (col: AnyPgColumn | SQL): SQL =>
  sql`coalesce(${col}, '') !~ ${sql.raw(`'${TEST_ORDER_SQL}'`)}`

/** A test order or chat, for a raw SQL text: `<column> ~ '<pattern>'`. */
export const IS_TEST = (column: string): SQL => sql.raw(`${column} ~ '${TEST_ORDER_SQL}'`)

/** The same for a raw SQL text: `<column> !~ '<pattern>'`. */
export const NOT_TEST = (column: string): SQL =>
  sql.raw(`coalesce(${column}, '') !~ '${TEST_ORDER_SQL}'`)
