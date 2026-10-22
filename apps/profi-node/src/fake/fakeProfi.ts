import {
  type EventEnvelope,
  newEventId,
  type ProfiOrder,
  type SessionHealthOutput,
  type SubmitBidInput,
  type SubmitBidOutput,
} from '@sara/shared'
import { verifyPermit } from '@sara/shared/permit'
import { type ExtraRoute, serveMcp } from '../mcp/http'
import { createProfiMcpServer, ProfiToolError } from '../mcp/server'
import { sampleOrders } from './sampleOrders'

export type FakeProfi = {
  url: string
  bids: SubmitBidInput[]
  emitOrder(o?: Partial<ProfiOrder>): Promise<string>
  redeliver(eventId: string): Promise<void>
  failNextAck(): void
  setCoreEventsUrl(url: string): void
  setHealth(h: Partial<SessionHealthOutput>): void
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fake Profi.ru behind contract C2 for development and tests; never touches the real site (ADR-017). */
export async function createFakeProfi(o: {
  port: number
  coreEventsUrl: string
  nodeToken: string
  permitSecret: string
  extra?: ExtraRoute
}): Promise<FakeProfi> {
  const bids: SubmitBidInput[] = []
  const results = new Map<string, SubmitBidOutput>()
  const sent = new Map<string, EventEnvelope>()
  let health: SessionHealthOutput = {
    alive: true,
    balance_rub: 5000,
    presence: true,
    egress_ip: '127.0.0.1',
  }
  let balance = 5000
  let dropNextAck = false
  let coreEventsUrl = o.coreEventsUrl

  const impl = {
    async sessionHealth() {
      return health
    },
    async submitBid(i: SubmitBidInput) {
      if (!verifyPermit(o.permitSecret, i.idempotency_key, i.permit)) {
        throw new ProfiToolError('INTERNAL', 'permit does not match idempotency_key')
      }
      const done = results.get(i.idempotency_key)
      if (done) return done
      balance -= 210
      const out: SubmitBidOutput = {
        found_on_page: true,
        spent_rub: 210,
        balance_after_rub: balance,
      }
      bids.push(i)
      results.set(i.idempotency_key, out)
      if (dropNextAck) {
        dropNextAck = false
        throw new Error('connection reset after the bid went out')
      }
      return out
    },
  }

  const server = await serveMcp(() => createProfiMcpServer(impl), o.port, o.extra)

  async function deliver(e: EventEnvelope): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(coreEventsUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sara-node-token': o.nodeToken },
          body: JSON.stringify(e),
        })
        if (res.ok) return
        lastError = new Error(`core answered ${res.status}`)
      } catch (err) {
        lastError = err
      }
      await sleep(200)
    }
    throw lastError
  }

  return {
    url: server.url,
    bids,
    async emitOrder(partial) {
      const base = sampleOrders()[0]
      if (!base) throw new Error('no sample orders')
      const order: ProfiOrder = { ...base, seen_at: new Date().toISOString(), ...partial }
      const e: EventEnvelope = {
        id: newEventId(),
        type: 'profi.order_seen',
        v: 1,
        entity: { kind: 'order', id: order.order_id },
        account_id: 'hance-marketing',
        actor: 'profi',
        occurred_at: order.seen_at,
        causation_id: null,
        correlation_id: newEventId(),
        reason: null,
        payload: order,
      }
      sent.set(e.id, e)
      await deliver(e)
      return e.id
    },
    async redeliver(eventId) {
      const e = sent.get(eventId)
      if (!e) throw new Error(`unknown event ${eventId}`)
      await deliver(e)
    },
    failNextAck() {
      dropNextAck = true
    },
    setCoreEventsUrl(url) {
      coreEventsUrl = url
    },
    setHealth(h) {
      health = { ...health, ...h }
    },
    close: server.close,
  }
}
