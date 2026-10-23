import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

export type NodeDb = NodePgDatabase<typeof schema>
export type NodeTx = Parameters<Parameters<NodeDb['transaction']>[0]>[0]
export type NodeDbOrTx = NodeDb | NodeTx

export function createNodeDb(url: string): { db: NodeDb; close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: url, max: 5 })
  return { db: drizzle(pool, { schema }), close: () => pool.end() }
}
