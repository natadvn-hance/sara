import { resolve } from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createNodeDb } from './client'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../drizzle')

/** Own migrations table, so the core's and the node's migrations never mix. */
export async function migrateNode(url: string): Promise<void> {
  const { db, close } = createNodeDb(url)
  try {
    await migrate(db, {
      migrationsFolder: MIGRATIONS_DIR,
      migrationsTable: '__drizzle_migrations_node',
    })
  } finally {
    await close()
  }
}
