import { newEventId } from '@sara/shared'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrateNode } from '../../profi-node/src/db/migrate'
import { formatShadowReport, shadowReport, shadowWindow } from '../src/analytics/shadow'
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
  type: 'profi.order_seen' | 'profi.client_message' | 'profi.author_unclear' | 'profi.session_dead',
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
  const messageId =
    typeof payload.platform_message_id === 'string' ? payload.platform_message_id : null
  await db.execute(
    messageId
      ? sql`update core.event set recorded_at = ${recordedAt} where entity_id = ${entityId} and type = ${type} and payload->>'platform_message_id' = ${messageId}`
      : sql`update core.event set recorded_at = ${recordedAt} where entity_id = ${entityId} and type = ${type}`,
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

  const message = async (
    id: string,
    sentAt: string,
    recordedAt: string,
    over: Record<string, unknown> = {},
  ) => {
    await rawMessage(id, sentAt)
    await journal('profi.client_message', 'c1', recordedAt, {
      platform_message_id: id,
      sent_at: sentAt,
      ...over,
    })
  }

  it('FR-CONV-1: a message the stream named is timed from the stream, one only the chat sweep found is not a fast one', async () => {
    await message('m1', at(0), at(0, 20), { seen_via: 'stream' })
    await message('m2', at(1), at(2, 30), { seen_via: 'stream' })
    // The sweep reads a chat every 10 minutes: when the message was sent is not known, so it is not counted as fast.
    await message('m3', at(3), at(3, 5), { seen_via: 'sweep' })
    // An event of an older node says nothing about how it was noticed: timed as a stream message.
    await message('m4', at(4), at(4, 10))
    const r = await shadowReport(db, from, to)
    expect(r.messages).toMatchObject({ count: 4, sweepFound: 1, under60sShare: 0.5 })
    expect(r.messages.p90SeenMs).toBe(90_000)
    expect(r.lostEvents).toBe(0)
  })

  it('FR-CONV-1: the report words the sweep-found messages and says plainly when no message came', async () => {
    expect(formatShadowReport(await shadowReport(db, from, to), from, to)).toContain(
      'Сообщения клиентов: за период не было',
    )
    await message('m1', at(0), at(0, 10), { seen_via: 'stream' })
    await message('m2', at(1), at(1, 5), { seen_via: 'sweep' })
    const text = formatShadowReport(await shadowReport(db, from, to), from, to)
    expect(text).toContain('Сообщения клиентов: 2, быстрее минуты 50% (цель 95%)')
    expect(text).toContain('найдено только обходом чатов: 1')
    expect(text).not.toContain(String.fromCharCode(0x2014))
  })

  it('FR-CONV-2: the report says what share of the messages had a known author', async () => {
    expect((await shadowReport(db, from, to)).authorKnownShare).toBeNull()
    expect(formatShadowReport(await shadowReport(db, from, to), from, to)).toContain(
      'Автор определён: нет сообщений',
    )
    await message('m1', at(0), at(0, 10), { seen_via: 'stream' })
    await message('m2', at(1), at(1, 10), { seen_via: 'stream' })
    await message('m3', at(2), at(2, 10), { seen_via: 'stream' })
    await rawMessage('m4', at(3))
    await journal('profi.author_unclear', 'c1', at(3, 10), {
      platform_message_id: 'm4',
      sent_at: at(3),
      seen_via: 'stream',
    })
    const r = await shadowReport(db, from, to)
    expect(r.authorKnownShare).toBe(0.75)
    expect(r.authorUnclear).toBe(1)
    expect(formatShadowReport(r, from, to)).toContain('Автор определён: 75% (цель 100%), неясен: 1')
  })

  it('FR-CONV-2: every message with an author is known, 100%', async () => {
    await message('m1', at(0), at(0, 10), { seen_via: 'stream' })
    const r = await shadowReport(db, from, to)
    expect(r.authorKnownShare).toBe(1)
    expect(formatShadowReport(r, from, to)).toContain(
      'Автор определён: 100% (цель 100%), неясен: 0',
    )
  })

  it('ST-M1-11: the window is 48 hours back from now, or the hours asked for, or the exact moments given', () => {
    const now = new Date('2026-10-26T07:00:00.000Z')
    expect(shadowWindow([], now)).toEqual({
      from: '2026-10-24T07:00:00.000Z',
      to: '2026-10-26T07:00:00.000Z',
    })
    expect(shadowWindow(['--hours', '24'], now).from).toBe('2026-10-25T07:00:00.000Z')
    // The shadow began on 24.10.2026 about 07:00 UTC: its report is cut there, whenever it is made.
    expect(
      shadowWindow(['--from', '2026-10-24T07:00:00Z', '--to', '2026-10-26T07:00:00Z'], new Date()),
    ).toEqual({ from: '2026-10-24T07:00:00.000Z', to: '2026-10-26T07:00:00.000Z' })
    expect(() => shadowWindow(['--from', 'вчера'], now)).toThrow(/--from/)
  })
})
