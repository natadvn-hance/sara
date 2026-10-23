import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { outboxNode, rawMessage } from '../src/db/schema'
import { upsertMessage, upsertOrder } from '../src/store/raw'
import { type AccountRuntime, createReadTools } from '../src/tools/readTools'
import { openNodeTestDb, resetNodeDb } from './helpers/db'

const { db, close } = openNodeTestDb()
afterAll(close)
beforeEach(() => resetNodeDb(db))

const runtime = (state: 'alive' | 'dead' = 'alive'): AccountRuntime => ({
  watch: { state: () => state },
  eyes: { balance: () => 4200, presence: () => true, lastRecognizedAt: () => Date.now() },
  egressIp: () => '203.0.113.9',
  egressOk: () => true,
  silenceMs: 600000,
})
const tools = (state: 'alive' | 'dead' = 'alive') =>
  createReadTools({ db, accounts: new Map([['hance-marketing', runtime(state)]]) })

const msg = (id: string, author: string, sentAt: string) => ({
  platform_message_id: id,
  chat_id: 'c-1',
  order_id: '95147898',
  author,
  sent_at: sentAt,
  text: `текст ${id}`,
  read: false,
})

describe('read tools', () => {
  it('C2: read_chat returns messages with platform id, author, time and read flag', async () => {
    await upsertMessage(db, {
      accountId: 'hance-marketing',
      message: msg('m2', 'specialist', '2026-10-23T08:01:00.000Z'),
    })
    await upsertMessage(db, {
      accountId: 'hance-marketing',
      message: msg('m1', 'client', '2026-10-23T08:00:00.000Z'),
    })
    const r = await tools().readChat({ account_id: 'hance-marketing', chat_id: 'c-1' })
    expect(r.messages.map((m) => [m.platform_message_id, m.author, m.sent_at, m.read])).toEqual([
      ['m1', 'client', '2026-10-23T08:00:00.000Z', false],
      ['m2', 'specialist', '2026-10-23T08:01:00.000Z', false],
    ])
  })

  it('FR-CONV-2: read_chat never returns a message without an author class', async () => {
    await upsertMessage(db, {
      accountId: 'hance-marketing',
      message: msg('m3', 'boris?', '2026-10-23T08:00:00.000Z'),
    })
    const r = await tools().readChat({ account_id: 'hance-marketing', chat_id: 'c-1' })
    expect(r.messages[0]?.author).toBe('unknown')
  })

  it('C2: list_feed and get_order return what the eyes have seen', async () => {
    const order = {
      order_id: '95147898',
      title: 'Сайт',
      category: 'Создание сайтов',
      city: 'Краснодар',
      text: 'Нужен сайт',
      client_name: 'Ирина',
      budget_text: null,
      bid_price_rub: 210,
      seen_at: '2026-10-23T08:00:00.000Z',
    }
    await upsertOrder(db, {
      accountId: 'hance-marketing',
      order,
      body: { ...order, published_at: '2026-10-23T07:59:00.000Z' },
    })
    expect((await tools().listFeed({ account_id: 'hance-marketing' })).orders).toEqual([
      {
        order_id: '95147898',
        title: 'Сайт',
        city: 'Краснодар',
        budget_text: null,
        bid_price_rub: 210,
        published_at: '2026-10-23T07:59:00.000Z',
      },
    ])
    expect(
      await tools().getOrder({ account_id: 'hance-marketing', order_id: '95147898' }),
    ).toMatchObject({ open: true, title: 'Сайт' })
  })

  it('C2: submit_bid in M1 is refused and touches nothing', async () => {
    await expect(
      tools().submitBid({
        account_id: 'hance-marketing',
        order_id: '1',
        text: 'x',
        idempotency_key: 'bid:1',
        permit: 'p',
      }),
    ).rejects.toMatchObject({ errorClass: 'INTERNAL' })
    expect(await db.select().from(outboxNode)).toHaveLength(0)
    expect(await db.select().from(rawMessage)).toHaveLength(0)
  })

  it('FR-OPS-2: on a dead session the read tools answer SESSION_DEAD', async () => {
    await expect(
      tools('dead').readChat({ account_id: 'hance-marketing', chat_id: 'c-1' }),
    ).rejects.toMatchObject({
      errorClass: 'SESSION_DEAD',
    })
  })

  it('FR-SET-5: session_health reports balance, presence, IP, queue and whether the eyes see', async () => {
    expect(await tools().sessionHealth({ account_id: 'hance-marketing' })).toEqual({
      alive: true,
      balance_rub: 4200,
      presence: true,
      egress_ip: '203.0.113.9',
      queued_events: 0,
      dead_events: 0,
      eyes_seeing: true,
      egress_ok: true,
    })
  })
})
