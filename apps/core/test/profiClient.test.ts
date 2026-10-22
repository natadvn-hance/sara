import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import type { EventEnvelope } from '@sara/shared'
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

beforeEach(async () => {
  await resetDb(db)
  seen = []
  app = Fastify()
  registerProfiEventsRoute(app, {
    db,
    nodeToken: 'node-tok',
    onEvent: async (e) => {
      seen.push(e)
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

  it('C2: session health is read through the contract', async () => {
    const client = createProfiClient({ url: fake.url, permitSecret: 'permit' })
    expect(await client.sessionHealth('hance-marketing')).toMatchObject({ alive: true })
  })

  it('C8: the same order_seen delivered twice is accepted once', async () => {
    const id = await fake.emitOrder({ order_id: '555' })
    await fake.redeliver(id)
    expect(seen).toHaveLength(1)
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
})
