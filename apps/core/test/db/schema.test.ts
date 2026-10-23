import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { dbErrorMessage, openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

async function insertEvent() {
  await db.execute(sql`insert into core.event
    (id, type, v, entity_kind, entity_id, account_id, actor, occurred_at, causation_id, correlation_id, reason, payload)
    values (gen_random_uuid(), 'lead.found', 1, 'lead', '1', null, 'sara', now(), null, gen_random_uuid(), null, '{}')`)
}

async function insertOutbox(key: string) {
  await db.execute(sql`insert into core.outbox (id, kind, idempotency_key, payload)
    values (gen_random_uuid(), 'bid', ${key}, '{}')`)
}

describe('schema', () => {
  it('FR-OPS-4: journal rejects update and delete', async () => {
    await insertEvent()
    expect(await dbErrorMessage(db.execute(sql`update core.event set reason = 'x'`))).toMatch(
      /append-only/,
    )
    expect(await dbErrorMessage(db.execute(sql`delete from core.event`))).toMatch(/append-only/)
  })

  it('FR-LEAD-4: outbox idempotency_key is unique', async () => {
    await insertOutbox('bid:1')
    await expect(insertOutbox('bid:1')).rejects.toThrow()
  })
})
