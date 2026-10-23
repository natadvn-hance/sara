import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { outboxNode, rawEvent } from '../src/db/schema'
import { purgeOld } from '../src/store/purge'
import { upsertOrder } from '../src/store/raw'
import { openNodeTestDb, resetNodeDb } from './helpers/db'

const { db, close } = openNodeTestDb()
afterAll(close)
beforeEach(() => resetNodeDb(db))

const DAY = 24 * 3600 * 1000
const now = new Date('2026-10-23T12:00:00.000Z')
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString()
const order = {
  order_id: '95147898',
  title: 'Сайт',
  category: 'Создание сайтов',
  city: 'Краснодар',
  text: 'Нужен сайт',
  client_name: 'Ирина',
  budget_text: null,
  bid_price_rub: 210,
  seen_at: now.toISOString(),
}

describe('node store', () => {
  it('ADR-022: raw data lives in schema node only', async () => {
    const r = await db.execute<{ table_schema: string; table_name: string }>(
      sql`select table_schema, table_name from information_schema.tables where table_name in ('raw_event','raw_order','raw_message','outbox_node')`,
    )
    expect(new Set(r.rows.map((x) => x.table_schema))).toEqual(new Set(['node']))
    expect(r.rows).toHaveLength(4)
  })

  it('FR-LEAD-1: the same order saved twice is new once', async () => {
    const o = { accountId: 'hance-marketing', order, body: { any: 1 } }
    expect(await upsertOrder(db, o)).toBe(true)
    expect(await upsertOrder(db, o)).toBe(false)
  })

  it('data-dictionary: purgeOld removes raw older than 30 days and confirmed outbox older than 7 days', async () => {
    await db.insert(rawEvent).values([
      {
        id: '01a16700-0000-7000-8000-000000000001',
        accountId: 'a',
        kind: 'rtp',
        receivedAt: ago(31),
        body: {},
      },
      {
        id: '01a16700-0000-7000-8000-000000000002',
        accountId: 'a',
        kind: 'rtp',
        receivedAt: ago(29),
        body: {},
      },
    ])
    await db.insert(outboxNode).values([
      {
        eventId: '01a16700-0000-7000-8000-000000000003',
        payload: {},
        nextTryAt: ago(40),
        confirmedAt: ago(8),
      },
      {
        eventId: '01a16700-0000-7000-8000-000000000004',
        payload: {},
        nextTryAt: ago(40),
        confirmedAt: null,
      },
    ])
    expect(await purgeOld(db, now)).toEqual({ raw: 1, outbox: 1 })
  })
})
