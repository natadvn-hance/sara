import pg from 'pg'
import { migrate } from '../src/db/migrate'
import { testDatabaseUrl } from './helpers/db'

export default async function setup() {
  const url = new URL(testDatabaseUrl())
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString() })
  await client.connect()
  const exists = await client.query('select 1 from pg_database where datname = $1', ['sara_test'])
  if (exists.rowCount === 0) await client.query('create database sara_test')
  await client.end()
  await migrate(url.toString())
}
