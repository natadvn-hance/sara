import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../src/db/client'
import { event } from '../../src/db/schema'

export async function countEvents(db: Db, type: string, entityId?: string): Promise<number> {
  const where = entityId
    ? and(eq(event.type, type), eq(event.entityId, entityId))
    : eq(event.type, type)
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(event).where(where)
  return rows[0]?.n ?? 0
}
