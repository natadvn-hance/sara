import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'
import { prepareTestDatabase } from '../../core/test/globalSetup'

/** Fresh database and data folder, so the wizard always starts from step 1. Runs before the core starts. */
export async function prepareDb() {
  await rm(resolve(import.meta.dirname, '../../../.sara/web-e2e'), { recursive: true, force: true })
  await prepareTestDatabase('sara_web')
  const client = new pg.Client({
    connectionString: 'postgres://sara:sara@localhost:54329/sara_web',
  })
  await client.connect()
  const t = await client.query("select tablename from pg_tables where schemaname = 'core'")
  if (t.rows.length)
    await client.query(`truncate ${t.rows.map((r) => `core."${r.tablename}"`).join(', ')} cascade`)
  await client.end()
}

if (import.meta.url === `file://${process.argv[1]}`) await prepareDb()
