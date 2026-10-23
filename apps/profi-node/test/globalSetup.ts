import pg from 'pg'
import { migrateNode } from '../src/db/migrate'
import { nodeTestUrl } from './helpers/db'

/** profi-node tests use their own database, so they do not race the core tests on migrations. */
export default async function setup() {
  const url = new URL(nodeTestUrl())
  const name = url.pathname.slice(1)
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString() })
  await client.connect()
  const exists = await client.query('select 1 from pg_database where datname = $1', [name])
  if (exists.rowCount === 0) await client.query(`create database "${name}"`)
  await client.end()
  await migrateNode(url.toString())
}
