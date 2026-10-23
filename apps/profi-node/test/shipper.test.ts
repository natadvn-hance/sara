import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { queueEvent } from '../src/ship/outbox'
import { createShipper, shipperHealth } from '../src/ship/shipper'
import { startTestCore } from './helpers/core'
import { openNodeTestDb, resetNodeDb } from './helpers/db'

const { db, close } = openNodeTestDb()
afterAll(close)
let core: Awaited<ReturnType<typeof startTestCore>>
beforeEach(async () => {
  await resetNodeDb(db)
  core = await startTestCore()
})
afterEach(() => core.close())

const order = (n: number) => ({
  order_id: String(n),
  title: 'Сайт',
  category: 'Создание сайтов',
  city: 'Краснодар',
  text: 'Нужен сайт',
  client_name: 'Ирина',
  budget_text: null,
  bid_price_rub: 210,
  seen_at: '2026-10-23T08:00:00.000Z',
})
const ev = (n: number) => ({
  type: 'profi.order_seen' as const,
  accountId: 'hance-marketing',
  entity: { kind: 'order', id: String(n) },
  payload: order(n),
})
const shipper = () =>
  createShipper({ db, coreEventsUrl: core.url, nodeToken: 't', backoffMs: [0, 0, 0] })

describe('event shipping', () => {
  it('ADR-019: events wait while the core is down and arrive once, in order, when it is back', async () => {
    core.down()
    for (const n of [1, 2, 3]) await queueEvent(db, ev(n))
    const s = shipper()
    await s.flush()
    expect(core.received).toHaveLength(0)
    expect((await shipperHealth(db)).queued).toBe(3)
    core.up()
    await s.flush()
    await s.flush()
    expect(core.received.map((e) => (e.payload as { order_id: string }).order_id)).toEqual([
      '1',
      '2',
      '3',
    ])
    expect((await shipperHealth(db)).queued).toBe(0)
  })

  it('ADR-019: an event that waits for its retry holds back the events after it', async () => {
    core.down()
    await queueEvent(db, ev(1))
    const s = createShipper({ db, coreEventsUrl: core.url, nodeToken: 't', backoffMs: [60000] })
    await s.flush()
    await queueEvent(db, ev(2))
    core.up()
    await s.flush()
    expect(core.received).toHaveLength(0)
  })

  it('ADR-019: a restart in the middle of the queue sends nothing twice', async () => {
    for (const n of [1, 2]) await queueEvent(db, ev(n))
    await shipper().flush()
    await queueEvent(db, ev(3))
    await shipper().flush()
    expect(core.received).toHaveLength(3)
  })

  it('C8: an event the core refuses as broken is set aside and reported, not retried forever', async () => {
    core.refuse()
    await queueEvent(db, ev(1))
    const s = shipper()
    await s.flush()
    await s.flush()
    expect(await shipperHealth(db)).toMatchObject({ queued: 0, dead: 1 })
  })

  it('ADR-022: an event payload that breaks its contract is refused before it is queued', async () => {
    await expect(
      queueEvent(db, { ...ev(1), type: 'profi.client_message', payload: { text: 'привет' } }),
    ).rejects.toThrow()
  })
})
