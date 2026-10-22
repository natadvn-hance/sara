import { sql } from 'drizzle-orm'
import { createDb, type Db } from '../../src/db/client'

export function testDatabaseUrl(): string {
  const base = process.env.DATABASE_URL ?? 'postgres://sara:sara@localhost:54329/sara'
  const u = new URL(base)
  u.pathname = '/sara_test'
  return u.toString()
}

export function openTestDb() {
  return createDb(testDatabaseUrl())
}

export async function resetDb(db: Db): Promise<void> {
  const rows = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'core'`,
  )
  const names = rows.rows.map((r) => `core."${r.tablename}"`).join(', ')
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`))
}

/** Drizzle wraps Postgres errors; the database message is on `cause`. */
export async function dbErrorMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    const err = e as Error & { cause?: Error }
    return err.cause?.message ?? err.message
  }
  return 'no error'
}
