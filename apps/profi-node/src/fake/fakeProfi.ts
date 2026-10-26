import {
  type ChatMessage,
  EventEnvelope,
  type GetOrderOutput,
  type MessageAuthor,
  newEventId,
  PROFI_EVENT_PAYLOADS,
  type ProfiErrorClass,
  type ProfiEventType,
  type ProfiOrder,
  type SendMessageInput,
  type SendMessageOutput,
  type SessionHealthOutput,
  type SubmitBidInput,
  type SubmitBidOutput,
} from '@sara/shared'
import { verifyMessagePermit, verifyPermit } from '@sara/shared/permit'
import { z } from 'zod'
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
    'open' | 'has_bid' | 'bid_price_rub' | 'client_name' | 'text' | 'client_info' | 'from_page'
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
  /**
   * A message appears in a chat: kept for read_chat and shipped as the event its author gives (a system notice
   * gives none, so its eventId is null). Without sentAt it comes 1 ms after the chat's last message at least.
   */
  addChatMessage(m: {
    chatId: string
    orderId?: string | null
    author: MessageAuthor
    text: string
    read?: boolean
    sentAt?: string
  }): Promise<{ platformMessageId: string; eventId: string | null }>
  emitTyping(chatId: string): Promise<void>
  emitRead(chatId: string, platformMessageId: string): Promise<void>
  redeliver(eventId: string): Promise<void>
  failNextAck(): void
  failAcks(n: number): void
  /** The next send goes out and is recorded, then its answer is lost. */
  failNextSendAck(): void
  setCoreEventsUrl(url: string): void
  setHealth(h: Partial<SessionHealthOutput>): void
  /** What a bid costs on the fake site now for every order (null: each order's own); get_order reads it too. */
  setFee(rub: number | null): void
  /** The next `times` calls of submit_bid fail with this class before anything is pressed. */
  refuseNext(errorClass: ProfiErrorClass, times?: number): void
  /** The order already has this account's bid, made by hand: submit_bid finds it and spends nothing. */
  markBid(orderId: string): void
  /** Called at the start of every submit_bid, before the fake decides anything. */
  onSubmit(hook: ((i: SubmitBidInput) => Promise<void> | void) | null): void
  /** session_health answers only after this many milliseconds. */
  delayHealth(ms: number): void
  /** send_message works (and answers) only after this many milliseconds: a tab that is busy; 0 is at once. */
  delaySend(ms: number): void
  close(): Promise<void>
}

type FakeChat = { orderId: string | null; messages: ChatMessage[] }

const ACCOUNT = 'hance-marketing'
const MESSAGE_EVENTS: Partial<Record<MessageAuthor, ProfiEventType>> = {
  client: 'profi.client_message',
  specialist: 'profi.specialist_message',
  unknown: 'profi.author_unclear',
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
  const chats = new Map<string, FakeChat>()
  let lastMessageNo = 0
  let health: SessionHealthOutput = {
    alive: true,
    balance_rub: 5000,
    presence: true,
    egress_ip: '127.0.0.1',
  }
  let balance = 5000
  let dropAcks = 0
  let dropSendAcks = 0
  let coreEventsUrl = o.coreEventsUrl
  // The fee of the fake site for every order; null: each order's own, as emitted (210 when it has none).
  let fee: number | null = null
  let refusal: { errorClass: ProfiErrorClass; times: number } | null = null
  let hook: ((i: SubmitBidInput) => Promise<void> | void) | null = null
  let healthDelay = 0
  let sendDelay = 0
  // Orders with this account's bid on the fake site.
  const onSite = new Set<string>()

  /** Appends to the chat in page order; a message without its own time comes after the chat's last one. */
  function append(
    chatId: string,
    m: {
      orderId?: string | null
      author: MessageAuthor
      text: string
      read: boolean
      sentAt?: string
    },
  ): { message: ChatMessage; orderId: string | null } {
    const known = chats.get(chatId)
    const last = known?.messages.at(-1)
    const lastAt = last ? Date.parse(last.sent_at) : 0
    // As the live node: the chat's page order is its time order, so a time is checked before anything is kept.
    if (m.sentAt !== undefined) {
      const given = Date.parse(m.sentAt)
      if (!Number.isFinite(given) || !z.iso.datetime().safeParse(m.sentAt).success)
        throw new Error(`sentAt ${m.sentAt} is not a time`)
      if (given <= lastAt) throw new Error(`sentAt ${m.sentAt} is before the chat's last message`)
    }
    // The live node sends the chat number as the order number.
    const chat = known ?? { orderId: chatId, messages: [] }
    chats.set(chatId, chat)
    if (m.orderId !== undefined) chat.orderId = m.orderId
    const message: ChatMessage = {
      platform_message_id: `fake-${++lastMessageNo}`,
      chat_id: chatId,
      author: m.author,
      sent_at: m.sentAt ?? new Date(Math.max(Date.now(), lastAt + 1)).toISOString(),
      text: m.text,
      read: m.read,
    }
    chat.messages.push(message)
    return { message, orderId: chat.orderId }
  }

  const impl = {
    async sessionHealth() {
      if (healthDelay > 0) await sleep(healthDelay)
      return health
    },
    // The fake keeps no feed: list_feed answers empty, as a fresh account would.
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
        ...(fee !== null && { bid_price_rub: fee }),
        has_bid: onSite.has(i.order_id),
        from_page: true,
        ...page,
      }
    },
    async listChats() {
      return {
        chats: [...chats].map(([chatId, c]) => ({
          chat_id: chatId,
          order_id: c.orderId,
          last_message_at: c.messages.reduce<string | null>(
            (a, m) => (a === null || Date.parse(m.sent_at) > Date.parse(a) ? m.sent_at : a),
            null,
          ),
          unread: c.messages.filter((m) => m.author === 'client' && !m.read).length,
        })),
      }
    },
    async readChat(i: { chat_id: string }) {
      const chat = chats.get(i.chat_id)
      if (!chat) throw new ProfiToolError('NOT_FOUND', `chat ${i.chat_id} is not known to the fake`)
      return { messages: chat.messages.map((m) => ({ ...m })) }
    },
    async submitBid(i: SubmitBidInput) {
      if (!verifyPermit(o.permitSecret, i)) {
        throw new ProfiToolError('INTERNAL', 'permit does not match the bid')
      }
      await hook?.(i)
      let out = results.get(i.idempotency_key)
      if (!out) {
        if (refusal && refusal.times > 0) {
          refusal.times--
          throw new ProfiToolError(refusal.errorClass, `the fake refuses: ${refusal.errorClass}`)
        }
        if (Date.now() > Date.parse(i.not_after))
          throw new ProfiToolError('RATE_LIMITED', 'the deadline of the press has passed')
        if (onSite.has(i.order_id))
          return {
            found_on_page: true,
            spent_rub: 0,
            balance_after_rub: balance,
            already_there: true,
          }
        const due = fee ?? (emitted.get(i.order_id)?.bid_price_rub || 210)
        if (due > i.max_fee_rub)
          throw new ProfiToolError('PRICE_CHANGED', `the bid costs ${due}, above ${i.max_fee_rub}`)
        balance -= due
        out = { found_on_page: true, spent_rub: due, balance_after_rub: balance }
        bids.push(i)
        onSite.add(i.order_id)
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
      if (sendDelay > 0) await new Promise((r) => setTimeout(r, sendDelay))
      const m = { accountId: i.account_id, chatId: i.chat_id, text: i.text, key: i.idempotency_key }
      if (!verifyMessagePermit(o.permitSecret, m, i.permit)) {
        throw new ProfiToolError('INTERNAL', 'permit does not match this message')
      }
      // A repeat answers first, before the check: its chat already has the message it sent.
      let out = sentMessages.get(i.idempotency_key)
      if (!out) {
        const last = chats.get(i.chat_id)?.messages.at(-1)?.platform_message_id ?? null
        if (i.expect_last_message_id !== last) {
          throw new ProfiToolError(
            'CHAT_CHANGED',
            `chat ${i.chat_id} ends with ${last ?? 'nothing'}, not ${i.expect_last_message_id ?? 'nothing'}`,
          )
        }
        const { message } = append(i.chat_id, { author: 'specialist', text: i.text, read: false })
        messages.push(i)
        out = { found_on_page: true, platform_message_id: message.platform_message_id }
        sentMessages.set(i.idempotency_key, out)
      }
      // A lost answer: the message is in the chat, the caller never hears back.
      if (dropSendAcks > 0) {
        dropSendAcks--
        throw new Error('connection reset after the message went out')
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

  /** A chat event as the live node queues it (src/ship/outbox.ts): the contract's payload, no client text. */
  async function shipChatEvent(
    type: ProfiEventType,
    chatId: string,
    payload: (at: string) => unknown,
  ): Promise<string> {
    const at = new Date().toISOString()
    // Checked as the live node's queue checks it (src/ship/outbox.ts): a broken envelope never leaves.
    const e: EventEnvelope = EventEnvelope.parse({
      id: newEventId(),
      type,
      v: 1,
      entity: { kind: 'chat', id: chatId },
      account_id: ACCOUNT,
      actor: 'profi',
      occurred_at: at,
      causation_id: null,
      correlation_id: newEventId(),
      reason: null,
      payload: PROFI_EVENT_PAYLOADS[type].parse(payload(at)),
    })
    sent.set(e.id, e)
    await deliver(e)
    return e.id
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
        account_id: ACCOUNT,
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
    async addChatMessage(m) {
      const { message, orderId } = append(m.chatId, { ...m, read: m.read ?? false })
      const type = MESSAGE_EVENTS[m.author]
      const eventId = type
        ? await shipChatEvent(type, m.chatId, () => ({
            chat_id: m.chatId,
            order_id: orderId,
            platform_message_id: message.platform_message_id,
            sent_at: message.sent_at,
            author: message.author,
          }))
        : null
      return { platformMessageId: message.platform_message_id, eventId }
    },
    async emitTyping(chatId) {
      await shipChatEvent('profi.client_typing', chatId, (at) => ({ chat_id: chatId, at }))
    },
    async emitRead(chatId, platformMessageId) {
      await shipChatEvent('profi.client_read', chatId, (at) => ({
        chat_id: chatId,
        platform_message_id: platformMessageId,
        at,
      }))
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
    failNextSendAck() {
      dropSendAcks = 1
    },
    setCoreEventsUrl(url) {
      coreEventsUrl = url
    },
    setHealth(h) {
      health = { ...health, ...h }
    },
    setFee(rub) {
      fee = rub
    },
    refuseNext(errorClass, times = 1) {
      refusal = { errorClass, times }
    },
    markBid(orderId) {
      onSite.add(orderId)
    },
    onSubmit(h) {
      hook = h
    },
    delayHealth(ms) {
      healthDelay = ms
    },
    delaySend(ms) {
      sendDelay = ms
    },
    close: server.close,
  }
}
