import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { type EventEnvelope, newEventId } from '@sara/shared'
import { sql } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProfiClient, ProfiError } from '../src/profi/client'
import { registerProfiEventsRoute } from '../src/profi/eventsRoute'
import { openTestDb, resetDb } from './helpers/db'
import { countEvents } from './helpers/events'

const { db, close } = openTestDb()
afterAll(close)

let app: FastifyInstance
let fake: FakeProfi
let seen: EventEnvelope[]
let failNextOnEvent = false

beforeEach(async () => {
  await resetDb(db)
  seen = []
  app = Fastify()
  registerProfiEventsRoute(app, {
    db,
    nodeToken: 'node-tok',
    onEvent: async (e) => {
      seen.push(e)
      if (failNextOnEvent) {
        failNextOnEvent = false
        throw new Error('core crashed before the workflow started')
      }
    },
  })
  const coreUrl = await app.listen({ port: 0, host: '127.0.0.1' })
  fake = await createFakeProfi({
    port: 0,
    coreEventsUrl: `${coreUrl}/internal/profi/events`,
    nodeToken: 'node-tok',
    permitSecret: 'permit',
  })
})
afterEach(async () => {
  await fake.close()
  await app.close()
})

const bid = {
  account_id: 'hance-marketing',
  order_id: '1',
  text: 'Добрый день!',
  max_fee_rub: 210,
  idempotency_key: 'bid:1',
}

describe('profi client and event intake', () => {
  it('C2: client signs the permit and gets the bid result', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    expect(await client.submitBid(bid)).toMatchObject({ found_on_page: true, spent_rub: 210 })
    expect(fake.bids).toHaveLength(1)
  })

  it('C2: repeated idempotency_key returns the first result and records one bid', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    const a = await client.submitBid(bid)
    const b = await client.submitBid(bid)
    expect(b).toEqual(a)
    expect(fake.bids).toHaveLength(1)
  })

  it('FR-CONV-9: the client signs a message permit and a repeat sends one message', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    const m = {
      account_id: 'hance-marketing',
      chat_id: '95147898',
      text: 'Добрый день',
      expect_last_message_id: null,
      idempotency_key: 'msg:t:1',
    }
    const a = await client.sendMessage(m)
    expect(a.found_on_page).toBe(true)
    expect(await client.sendMessage(m)).toEqual(a)
    expect(fake.messages).toHaveLength(1)
  })

  it('FR-CONV-1: the client reads chats through the node', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    expect(await client.listChats('hance-marketing')).toEqual({ chats: [] })
    await expect(client.readChat('hance-marketing', 'none')).rejects.toMatchObject({
      errorClass: 'NOT_FOUND',
    })
    await expect(client.getOrder('hance-marketing', 'none')).rejects.toMatchObject({
      errorClass: 'NOT_FOUND',
    })
  })

  it('C2: tool error arrives as ProfiError with its class', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'wrong-secret' })
    await expect(client.submitBid(bid)).rejects.toMatchObject({ errorClass: 'INTERNAL' })
  })

  it('NFR-REL-4: lost acknowledgement is UNCERTAIN and a retry does not bid twice', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    fake.failNextAck()
    const err = await client.submitBid(bid).catch((e) => e)
    expect(err).toBeInstanceOf(ProfiError)
    expect(err.errorClass).toBe('UNCERTAIN')
    expect(await client.submitBid(bid)).toMatchObject({ found_on_page: true })
    expect(fake.bids).toHaveLength(1)
  })

  it('C2: the permit covers the order, the most the bid may cost and a deadline minutes ahead', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    const before = Date.now()
    await client.submitBid(bid)
    const sent = fake.bids[0]
    expect(sent).toMatchObject({ order_id: '1', max_fee_rub: 210 })
    // The SDK's own minute would give up while the bid waits for the tab: the call waits minutes.
    const ahead = Date.parse(sent?.not_after ?? '') - before
    expect(ahead).toBeGreaterThan(3 * 60_000)
    expect(ahead).toBeLessThanOrEqual(5 * 60_000)
  })

  it('FR-LEAD-9: a bid dearer than max_fee_rub is refused as PRICE_CHANGED', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    await expect(client.submitBid({ ...bid, max_fee_rub: 200 })).rejects.toMatchObject({
      errorClass: 'PRICE_CHANGED',
    })
    expect(fake.bids).toHaveLength(0)
  })

  it('NFR-REL-4: a node that does not answer within the timeout is UNCERTAIN, and its deadline is before it', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit', tabTimeoutMs: 400 })
    let deadline = 0
    fake.onSubmit(async (i) => {
      deadline = Date.parse(i.not_after)
      await new Promise((r) => setTimeout(r, 1500))
    })
    const started = Date.now()
    const err = await client.submitBid(bid).catch((e) => e)
    fake.onSubmit(null)
    expect(err).toMatchObject({ errorClass: 'UNCERTAIN' })
    expect(Date.now() - started).toBeLessThan(1400)
    expect(deadline).toBeLessThan(started + 400)
  })

  it('C2: get_order reads the order and whether this account bid', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    await fake.emitOrder({ order_id: '1' })
    expect(await client.getOrder('hance-marketing', '1')).toMatchObject({
      order_id: '1',
      has_bid: false,
      bid_price_rub: 210,
    })
    await client.submitBid(bid)
    expect((await client.getOrder('hance-marketing', '1')).has_bid).toBe(true)
  })

  it('C2: session health is read through the contract', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    expect(await client.sessionHealth('hance-marketing')).toMatchObject({ alive: true })
  })

  it('C8: the same order_seen delivered twice is journaled once and reported as a duplicate', async () => {
    const id = await fake.emitOrder({ order_id: '555' })
    await fake.redeliver(id)
    expect(await countEvents(db, 'profi.order_seen')).toBe(1)
    // Processing is triggered again on purpose (it is idempotent); one lead, one card is checked in e2e.
    expect(seen).toHaveLength(2)
  })

  it('C8: an order whose processing failed is processed again on redelivery', async () => {
    failNextOnEvent = true
    const id = await fake.emitOrder({ order_id: '556' }).catch(() => '')
    if (id) await fake.redeliver(id)
    expect(seen.filter((e) => e.entity.id === '556').length).toBeGreaterThanOrEqual(2)
    expect(await countEvents(db, 'profi.order_seen')).toBe(1)
  })

  it('C8: wrong node token is refused', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/profi/events',
      headers: { 'x-sara-node-token': 'nope' },
      payload: {},
    })
    expect(res.statusCode).toBe(401)
    expect(await countEvents(db, 'profi.order_seen')).toBe(0)
  })

  it('C8: an envelope that breaks the contract is refused', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/profi/events',
      headers: { 'x-sara-node-token': 'node-tok' },
      payload: { type: 'profi.order_seen' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('FR-LEAD-5: get_order is read through the contract with the client info', async () => {
    await fake.emitOrder({ order_id: '601', bid_price_rub: 0 })
    fake.setOrderPage('601', {
      bid_price_rub: 145,
      client_info: {
        name: 'Ирина',
        on_profi_since: null,
        phone_verified: null,
        reviews: null,
        review_tags: [],
      },
    })
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    expect(await client.getOrder('hance-marketing', '601')).toMatchObject({
      order_id: '601',
      open: true,
      bid_price_rub: 145,
      client_info: { name: 'Ирина' },
    })
  })

  it('FR-LEAD-5: a get_order the node answers too late is UNCERTAIN', async () => {
    await fake.emitOrder({ order_id: '602' })
    fake.setOrderPage('602', { delayMs: 800 })
    const client = createProfiClient({
      url: fake.url,
      permitSecret: 'permit',
      getOrderTimeoutMs: 200,
    })
    await expect(client.getOrder('hance-marketing', '602')).rejects.toMatchObject({
      errorClass: 'UNCERTAIN',
    })
  })

  it('FR-LEAD-5: a get_order the node refuses arrives as ProfiError with its class', async () => {
    await fake.emitOrder({ order_id: '603' })
    fake.setOrderPage('603', { fail: 'LAYOUT_CHANGED' })
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    await expect(client.getOrder('hance-marketing', '603')).rejects.toMatchObject({
      errorClass: 'LAYOUT_CHANGED',
    })
  })

  it('FR-CONV-1: a client message says how it was noticed, and the journal keeps that', async () => {
    const payload = {
      chat_id: '95300009',
      order_id: '95300009',
      platform_message_id: '13',
      sent_at: new Date().toISOString(),
      author: 'client',
      seen_via: 'sweep',
    }
    const res = await app.inject({
      method: 'POST',
      url: '/internal/profi/events',
      headers: { 'x-sara-node-token': 'node-tok' },
      payload: {
        id: newEventId(),
        type: 'profi.client_message',
        v: 1,
        entity: { kind: 'chat', id: '95300009' },
        account_id: 'hance-marketing',
        actor: 'profi',
        occurred_at: payload.sent_at,
        causation_id: null,
        correlation_id: newEventId(),
        reason: null,
        payload,
      },
    })
    expect(res.statusCode).toBe(200)
    const [row] = (
      await db.execute<{ payload: Record<string, unknown> }>(
        sql`select payload from core.event where type = 'profi.client_message'`,
      )
    ).rows
    expect(row?.payload).toMatchObject({ platform_message_id: '13', seen_via: 'sweep' })
  })
})
