import { sql } from 'drizzle-orm'
import { createNodeDb, type NodeDb } from '../../src/db/client'

export function nodeTestUrl(name = 'sara_node_test'): string {
  const u = new URL(process.env.DATABASE_URL ?? 'postgres://sara:sara@localhost:54329/sara')
  u.pathname = `/${name}`
  return u.toString()
}

export function openNodeTestDb() {
  return createNodeDb(nodeTestUrl())
}

export async function resetNodeDb(db: NodeDb): Promise<void> {
  await db.execute(
    sql`truncate node.raw_event, node.raw_order, node.raw_message, node.outbox_node, node.bid_attempt, node.node_flag`,
  )
}
