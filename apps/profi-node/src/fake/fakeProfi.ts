import {
  type EventEnvelope,
  type GetOrderOutput,
  newEventId,
  type ProfiErrorClass,
  type ProfiOrder,
  type SendMessageInput,
  type SendMessageOutput,
  type SessionHealthOutput,
  type SubmitBidInput,
  type SubmitBidOutput,
} from '@sara/shared'
import { verifyMessagePermit, verifyPermit } from '@sara/shared/permit'
import { type ExtraRoute, serveMcp } from '../mcp/http'
import { createProfiMcpServer, ProfiToolError } from '../mcp/server'
import { sampleOrders } from './sampleOrders'

/**
 * What the order page of a fake order shows when get_order reads it. Without a page set, the fake answers with the
 * order it emitted: open, not bid on, its fee and words as emitted. `fail` makes the read fail with that class,
 * `delayMs` makes the answer slow.
 */
export type FakeOrderPage = Partial<
  Pick<
    GetOrderOutput,
    'open' | 'has_bid' | 'bid_price_rub' | 'client_name' | 'text' | 'client_info'
  >
> & { fail?: ProfiErrorClass; delayMs?: number }

export type FakeProfi = {
  url: string
  bids: SubmitBidInput[]
  messages: SendMessageInput[]
  /** Order numbers get_order was asked for, in order. */
  orderReads: string[]
  emitOrder(o?: Partial<ProfiOrder>): Promise<string>
  setOrderPage(orderId: string, page: FakeOrderPage): void
  redeliver(eventId: string): Promise<void>
  failNextAck(): void
  failAcks(n: number): void
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
  const orderReads: string[] = []
  const emitted = new Map<string, ProfiOrder>()
  const pages = new Map<string, FakeOrderPage>()
  const results = new Map<string, SubmitBidOutput>()
  const messages: SendMessageInput[] = []
  const sentMessages = new Map<string, SendMessageOutput>()
  const sent = new Map<string, EventEnvelope>()
  let health: SessionHealthOutput = {
    alive: true,
    balance_rub: 5000,
    presence: true,
    egress_ip: '127.0.0.1',
  }
  let balance = 5000
  let dropAcks = 0
  let coreEventsUrl = o.coreEventsUrl

  const impl = {
    async sessionHealth() {
      return health
    },
    // The fake keeps no feed or chats: read tools answer empty, as a fresh account would.
    async listFeed() {
      return { orders: [] }
    },
    async getOrder(i: { order_id: string }): Promise<GetOrderOutput> {
      orderReads.push(i.order_id)
      const order = emitted.get(i.order_id)
      if (!order)
        throw new ProfiToolError('NOT_FOUND', `order ${i.order_id} is not known to the fake`)
      const { fail, delayMs, ...page } = pages.get(i.order_id) ?? {}
      if (delayMs) await sleep(delayMs)
      if (fail) throw new ProfiToolError(fail, `the fake order page fails with ${fail}`)
      return {
        ...order,
        published_at: order.published_at ?? null,
        open: true,
        has_bid: false,
        ...page,
      }
    },
    async listChats() {
      return { chats: [] }
    },
    async readChat(i: { chat_id: string }): Promise<never> {
      throw new ProfiToolError('NOT_FOUND', `chat ${i.chat_id} is not known to the fake`)
    },
    async submitBid(i: SubmitBidInput) {
      if (!verifyPermit(o.permitSecret, i.idempotency_key, i.permit)) {
        throw new ProfiToolError('INTERNAL', 'permit does not match idempotency_key')
      }
      let out = results.get(i.idempotency_key)
      if (!out) {
        balance -= 210
        out = { found_on_page: true, spent_rub: 210, balance_after_rub: balance }
        bids.push(i)
        results.set(i.idempotency_key, out)
      }
      // A lost answer: the bid is on the site, the caller never hears back.
      if (dropAcks > 0) {
        dropAcks--
        throw new Error('connection reset after the bid went out')
      }
      return out
    },
    async sendMessage(i: SendMessageInput) {
      const m = { accountId: i.account_id, chatId: i.chat_id, text: i.text, key: i.idempotency_key }
      if (!verifyMessagePermit(o.permitSecret, m, i.permit)) {
        throw new ProfiToolError('INTERNAL', 'permit does not match this message')
      }
      let out = sentMessages.get(i.idempotency_key)
      if (!out) {
        messages.push(i)
        out = { found_on_page: true, platform_message_id: `fake-sent-${messages.length}` }
        sentMessages.set(i.idempotency_key, out)
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
    messages,
    orderReads,
    setOrderPage(orderId, page) {
      pages.set(orderId, page)
    },
    async emitOrder(partial) {
      const base = sampleOrders()[0]
      if (!base) throw new Error('no sample orders')
      const order: ProfiOrder = { ...base, seen_at: new Date().toISOString(), ...partial }
      emitted.set(order.order_id, order)
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
      dropAcks = 1
    },
    failAcks(n) {
      dropAcks = n
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
