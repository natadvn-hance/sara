import pg from 'pg'
import { migrate } from '../src/db/migrate'

/** Creates the test database if needed, empties its DBOS system database and runs migrations. */
export async function prepareTestDatabase(name: string): Promise<void> {
  const base = new URL(process.env.DATABASE_URL ?? 'postgres://sara:sara@localhost:54329/sara')
  const admin = new URL(base)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString() })
  await client.connect()
  const exists = await client.query('select 1 from pg_database where datname = $1', [name])
  if (exists.rowCount === 0) await client.query(`create database "${name}"`)
  // Each run starts with an empty DBOS system database, so old workflows are not recovered.
  await client.query(`drop database if exists "${name}_dbos_sys" with (force)`)
  await client.end()
  const url = new URL(base)
  url.pathname = `/${name}`
  await migrate(url.toString())
}

export default () => prepareTestDatabase('sara_test')
