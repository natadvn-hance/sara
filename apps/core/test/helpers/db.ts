import { sql } from 'drizzle-orm'
import { createDb, type Db } from '../../src/db/client'

export function testDatabaseUrl(): string {
  const base = process.env.DATABASE_URL ?? 'postgres://sara:sara@localhost:54329/sara'
  const u = new URL(base)
  u.pathname = `/${process.env.SARA_TEST_DB ?? 'sara_test'}`
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
  if (!names) return
  // A workflow still finishing from the test before may hold a lock the truncate needs; Postgres then picks the
  // truncate as the deadlock victim (40P01, seen in tests/e2e/money.test.ts). It is safe to try again.
  for (let attempt = 1; ; attempt++) {
    try {
      await db.execute(sql.raw(`truncate ${names} restart identity cascade`))
      return
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code
      if (code !== '40P01' || attempt === 5) throw e
      await new Promise((r) => setTimeout(r, 100 * attempt))
    }
  }
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
