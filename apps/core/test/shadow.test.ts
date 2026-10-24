import { newEventId } from '@sara/shared'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrateNode } from '../../profi-node/src/db/migrate'
import { formatShadowReport, shadowReport } from '../src/analytics/shadow'
import { appendEventIfNew } from '../src/journal/journal'
import { openTestDb, resetDb, testDatabaseUrl } from './helpers/db'

const { db, close } = openTestDb()
beforeAll(() => migrateNode(testDatabaseUrl()))
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
  await db.execute(sql`truncate node.raw_order, node.raw_message, node.raw_event, node.outbox_node`)
})

const from = '2026-10-25T00:00:00.000Z'
const to = '2026-10-27T00:00:00.000Z'
const at = (min: number, sec = 0) =>
  new Date(Date.parse('2026-10-25T10:00:00.000Z') + min * 60_000 + sec * 1000).toISOString()

async function journal(
  type: 'profi.order_seen' | 'profi.client_message' | 'profi.session_dead',
  entityId: string,
  recordedAt: string,
  payload: Record<string, unknown>,
) {
  await appendEventIfNew(db, {
    id: newEventId(),
    type,
    v: 1,
    entity: { kind: type === 'profi.order_seen' ? 'order' : 'chat', id: entityId },
    account_id: 'hance-marketing',
    actor: 'profi',
    occurred_at: recordedAt,
    recorded_at: recordedAt,
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload,
  })
  // recorded_at is set by the journal on insert; the test pins it to the moment the core got the event.
  await db.execute(sql`alter table core.event disable trigger event_append_only`)
  await db.execute(
    sql`update core.event set recorded_at = ${recordedAt} where entity_id = ${entityId} and type = ${type}`,
  )
  await db.execute(sql`alter table core.event enable trigger event_append_only`)
}

async function rawOrder(id: string, publishedAt: string, seenAt = publishedAt) {
  await db.execute(
    sql`insert into node.raw_order (order_id, account_id, seen_at, body) values (${id}, 'hance-marketing', ${seenAt}, ${JSON.stringify({ published_at: publishedAt })}::jsonb)`,
  )
}
async function rawMessage(id: string, sentAt: string) {
  await db.execute(
    sql`insert into node.raw_message (platform_message_id, chat_id, account_id, author, sent_at, text) values (${id}, 'c1', 'hance-marketing', 'client', ${sentAt}, 'x')`,
  )
}

describe('shadow report', () => {
  it('ST-M1-11: shadow report counts orders seen under 60 s', async () => {
    await rawOrder('1', at(0))
    await journal('profi.order_seen', '1', at(0, 20), {})
    await rawOrder('2', at(5))
    await journal('profi.order_seen', '2', at(7), {})
    const r = await shadowReport(db, from, to)
    expect(r.orders).toMatchObject({ count: 2, under60sShare: 0.5 })
    expect(r.orders.p90SeenMs).toBe(120_000)
  })

  it('ST-M1-11: a raw message with no core event counts as lost', async () => {
    await rawMessage('m1', at(0))
    await journal('profi.client_message', 'c1', at(0, 10), {
      platform_message_id: 'm1',
      sent_at: at(0),
    })
    await rawMessage('m2', at(1))
    await journal('profi.session_dead', 'hance-marketing', at(2), {})
    const r = await shadowReport(db, from, to)
    expect(r.messages).toMatchObject({ count: 1, under60sShare: 1 })
    expect(r.lostEvents).toBe(1)
    expect(r.sessionDeaths).toBe(1)
  })

  it('NFR-UX-1: the report for Boris is plain Russian without a long dash', async () => {
    const text = formatShadowReport(await shadowReport(db, from, to), from, to)
    expect(text).toContain('Тень')
    expect(text).not.toContain(String.fromCharCode(0x2014))
  })

  it('ST-M1-11: an old or reposted order is not a new one, it is counted apart from the speed', async () => {
    await rawOrder('1', at(0))
    await journal('profi.order_seen', '1', at(0, 20), {})
    // Published long before Sara first saw it: an order that came back up the board, not a new order.
    await rawOrder('2', '2026-10-20T08:00:00.000Z', at(3))
    await journal('profi.order_seen', '2', at(3, 10), {})
    const r = await shadowReport(db, from, to)
    expect(r.orders).toMatchObject({ count: 1, under60sShare: 1 })
    expect(r.oldOrders).toBe(1)
    expect(formatShadowReport(r, from, to)).toContain('Старые и поднятые заказы: 1')
  })
})
