import { resolve } from 'node:path'
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator'
import { createDb } from './client'

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../drizzle')

export async function migrate(url: string): Promise<void> {
  const { db, close } = createDb(url)
  try {
    await runMigrations(db, { migrationsFolder: MIGRATIONS_DIR })
  } finally {
    await close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../config')
  await migrate(loadConfig().databaseUrl)
  console.log('Миграции применены')
}
