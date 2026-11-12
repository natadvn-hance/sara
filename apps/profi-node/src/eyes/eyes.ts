import { and, desc, eq, gte, inArray, max, sql } from 'drizzle-orm'
import type { NodeDb } from '../db/client'
import { bidAttempt, clientSawBid, rawMessage, rawOrder } from '../db/schema'
import { queueEvent } from '../ship/outbox'
import { KNOWN_CHAT, markReadByClient, saveRaw, upsertMessage, upsertOrder } from '../store/raw'
import type { MessageSignal, OrderSignal, ParseResult, Parsers, Signal } from './parsers'
import type { RawRecord } from './recorder'

export type Eyes = {
  onRaw(r: RawRecord): Promise<void>
  onParsed(p: ParseResult, source: 'rtp' | 'response' | 'dom', body?: unknown): Promise<void>
  /** active: the account is working (logged in, online, own IP); otherwise the silence clock restarts. */
  checkSilence(now?: number, active?: boolean): Promise<void>
  lastRecognizedAt(): number
  balance(): number | null
  /** The order was already seen on this account (no need to open its page again). */
  knowsOrder(orderId: string): Promise<boolean>
  /** Chats the event stream named since their page was last read. */
  chatsTouched(): string[]
  /** Chats with news seen in the last 3 days, newest first, 3 at most: what the 10-minute check rereads. */
  knownChats(now?: number): Promise<string[]>
  /**
   * The time (ms) of the newest message the node holds of each of these chats. It is never before the message's real
   * time: a message read from the page takes the moment it was seen, one the stream named that moment.
   */
  lastStored(chatIds: string[]): Promise<Map<string, number>>
  /**
   * A chat page was read. On the first reading of a chat only the client's messages after our last one are news;
   * what came before is history from before Sara watched, kept without events.
   */
  onChatRead(chatId: string, p: ParseResult): Promise<void>
  /** The site's board answer was read in the last 10 minutes. */
  boardWorks(now?: number): boolean
  /**
   * The board answers read so far: how many (a counter, to tell a new one from the last), whether the last one said the
   * board has more pages, and how many orders it said the whole board holds (null: it did not say). Null before the
   * first. The minute check scrolls the board by it.
   */
  board(): { seq: number; more: boolean; total: number | null } | null
  /**
   * A pass over the board begins (the minute check opens the feed) and ends (its scroll is done). An order the last
   * pass saw is gone from the feed when this pass does not show it although it loaded the page the order was on, and
   * the page after it (or the board to its end): the client closed it, most likely. `profi.order_gone` tells the
   * core, which reads the page of a waiting card's order at once (FR-LEAD-5).
   */
  boardPassStart(): void
  boardPassEnd(now?: number): Promise<void>
  presence(): boolean
  reset(): void
}

// Old Sara's line between a live chat and an old one (v1, OLD_ESCALATION_AFTER_MS).
const KNOWN_CHAT_MS = 3 * 24 * 3600 * 1000
/** An order the board keeps losing and finding (its place moves by relevance) is told gone at most this often. */
const GONE_EVERY_MS = 3600 * 1000

/**
 * Turns raw platform data into Profi events: each order and message once, by its platform number, whichever
 * eye saw it first (FR-LEAD-1, FR-CONV-1). Raw data stays in schema node; events carry no client text.
 */
export function createEyes(o: {
  accountId: string
  db: NodeDb
  parsers: Parsers
  layoutSilenceMs?: number
}): Eyes {
  const silenceMs = o.layoutSilenceMs ?? 600000
  let lastRecognized = Date.now()
  let layoutReported = false
  let balance: number | null = null
  let presence = false
  const WAITING_MAX = 100
  // The fee from the order page's own answer: truer than the page text, which misses a discount.
  const fees = new Map<string, { rub: number; baseRub: number | null; hasBid: boolean | null }>()
  let boardAt = 0
  let board: { seq: number; more: boolean; total: number | null } | null = null
  // chat → when the stream named it and which message, for the time the message really came.
  const touched = new Map<string, { at: string; messageId: string | null }>()
  // order → the first board page (from 0) it was on, in the pass going on and in the last one; when it was told gone.
  let pass: { orders: Map<string, number>; pages: number } | null = null
  let lastPass: Map<string, number> | null = null
  const goneAt = new Map<string, number>()

  async function knowsOrder(orderId: string): Promise<boolean> {
    const rows = await o.db
      .select({ id: rawOrder.orderId })
      .from(rawOrder)
      .where(and(eq(rawOrder.orderId, orderId), eq(rawOrder.accountId, o.accountId)))
      .limit(1)
    return rows.length > 0
  }

  /**
   * An order read from its page (the fallback when the board is silent) takes the fee of the page's own answer,
   * which is truer than the page text: it counts a discount. A board order has no fee yet (0 stands for unknown):
   * the core reads the page itself, once the order passed the Scorer (get_order).
   */
  function withFee(s: OrderSignal): OrderSignal {
    const id = s.order.order_id
    const fee = fees.get(id)
    fees.delete(id)
    if (!fee) return s
    return {
      ...s,
      order: { ...s.order, bid_price_rub: fee.rub },
      answer: { baseRub: fee.baseRub, hasBid: fee.hasBid },
    }
  }

  // Chats already noted this run: the list says it again on every read, every 2 minutes.
  const sawNoted = new Set<string>()

  /**
   * The client of this chat has seen our bid, by the chats list: one profi.client_read a chat. Only for a chat the core
   * knows: a bid Sara made (a press in node.bid_attempt) or a chat the node told the core of (a bid Boris sent himself,
   * 10.11.2026: 41 of 62 seen chats had no press). The list also names dozens of older chats, for which the core would
   * make an empty conversation and which have no topic to mark. Those are written down without an event.
   */
  async function noteClientSaw(chatId: string) {
    if (sawNoted.has(chatId)) return
    const at = new Date().toISOString()
    await o.db
      .transaction(async (tx) => {
        const fresh = await tx
          .insert(clientSawBid)
          .values({ accountId: o.accountId, chatId, seenAt: at })
          .onConflictDoNothing()
          .returning({ chatId: clientSawBid.chatId })
        if (fresh.length === 0) return
        const ours = await tx
          .select({ key: bidAttempt.idempotencyKey })
          .from(bidAttempt)
          .where(and(eq(bidAttempt.accountId, o.accountId), eq(bidAttempt.orderId, chatId)))
          .limit(1)
        if (ours.length === 0) {
          const [known] = await tx
            .execute<{ known: boolean }>(sql`select ${KNOWN_CHAT(o.accountId, chatId)} as known`)
            .then((r) => r.rows)
          if (!known?.known) return
        }
        await queueEvent(tx, {
          type: 'profi.client_read',
          accountId: o.accountId,
          entity: { kind: 'chat', id: chatId },
          // The order chat lives under the order's number.
          payload: { chat_id: chatId, order_id: chatId, platform_message_id: null, at },
        })
      })
      .then(() => sawNoted.add(chatId))
      .catch((err) =>
        console.error(
          'client saw bid not noted',
          err instanceof Error ? err.message.slice(0, 120) : err,
        ),
      )
  }

  // The messages the chat answers said the client read, newest last: the answer of a chat page may come before the
  // page's bubbles are stored, so a message stored later is looked up here once it is (onChatRead).
  const readIds = new Set<string>()
  const READ_IDS_MAX = 500

  /**
   * The client read these messages: ours the node held unread become read, and the core hears it once a chat, with the
   * last of them (it marks ours up to that one). A chat the core never heard of gets no event (an old chat).
   */
  async function clientRead(messageIds: string[]) {
    await o.db
      .transaction(async (tx) => {
        for (const r of await markReadByClient(tx, o.accountId, messageIds)) {
          if (!r.known) continue
          await queueEvent(tx, {
            type: 'profi.client_read',
            accountId: o.accountId,
            entity: { kind: 'chat', id: r.chatId },
            payload: {
              chat_id: r.chatId,
              order_id: r.orderId,
              platform_message_id: r.platformMessageId,
              at: new Date().toISOString(),
            },
          })
        }
      })
      .catch((err) =>
        console.error(
          'client read not noted',
          err instanceof Error ? err.message.slice(0, 120) : err,
        ),
      )
  }

  async function onSignals(
    signals: Signal[],
    body: unknown,
    quiet: Set<string> = new Set(),
    via?: 'stream' | 'sweep',
  ): Promise<void> {
    for (const raw of signals) {
      let s = raw
      if (s.t === 'chat_touched') {
        if (touched.size < WAITING_MAX || touched.has(s.chatId))
          touched.set(s.chatId, { at: new Date().toISOString(), messageId: s.messageId })
        continue
      }
      if (s.t === 'order_fee') {
        // Kept until its order is read; the oldest goes first, so a stuck tab cannot grow it.
        fees.delete(s.orderId)
        if (fees.size >= WAITING_MAX) fees.delete(fees.keys().next().value ?? '')
        fees.set(s.orderId, { rub: s.rub, baseRub: s.baseRub, hasBid: s.hasBid })
        continue
      }
      if (s.t === 'order') s = withFee(s)
      if (s.t === 'balance') {
        if (balance !== s.rub) {
          const first = balance === null
          balance = s.rub
          if (!first) {
            await queueEvent(o.db, {
              type: 'profi.balance_changed',
              accountId: o.accountId,
              entity: { kind: 'account', id: o.accountId },
              payload: { balance_rub: s.rub },
            })
          }
        }
        continue
      }
      if (s.t === 'presence') {
        presence = s.on
        continue
      }
      if (s.t === 'client_saw_bid') {
        await noteClientSaw(s.chatId)
        continue
      }
      if (s.t === 'read_by_client') {
        for (const id of s.messageIds) {
          readIds.delete(id)
          readIds.add(id)
        }
        while (readIds.size > READ_IDS_MAX) readIds.delete(readIds.values().next().value ?? '')
        await clientRead(s.messageIds)
        continue
      }
      // One broken signal (an odd date, a missing field) must not stop the rest of the batch; its raw record stays.
      await o.db
        .transaction(async (tx) => {
          if (s.t === 'order') {
            const isNew = await upsertOrder(tx, {
              accountId: o.accountId,
              order: s.order,
              body: {
                ...s.order,
                published_at: s.published_at,
                ...(s.answer && {
                  bid_base_price_rub: s.answer.baseRub,
                  has_bid: s.answer.hasBid,
                }),
              },
            })
            if (!isNew) return
            await queueEvent(tx, {
              type: 'profi.order_seen',
              accountId: o.accountId,
              entity: { kind: 'order', id: s.order.order_id },
              payload: { ...s.order, published_at: s.published_at },
            })
            return
          }
          const m = s.message
          const history = quiet.has(m.platform_message_id)
          const isNew = await upsertMessage(tx, { accountId: o.accountId, message: m, history })
          if (!isNew || history || m.author === 'system') return
          await queueEvent(tx, {
            type:
              m.author === 'client'
                ? 'profi.client_message'
                : m.author === 'specialist'
                  ? 'profi.specialist_message'
                  : 'profi.author_unclear',
            accountId: o.accountId,
            entity: { kind: 'chat', id: m.chat_id },
            payload: {
              chat_id: m.chat_id,
              order_id: m.order_id,
              platform_message_id: m.platform_message_id,
              sent_at: m.sent_at,
              author: m.author,
              // How a client's message was noticed; our own side's messages are not timed.
              ...(via && m.author !== 'specialist' && { seen_via: via }),
            },
          })
        })
        .catch((err) =>
          console.error(
            'signal skipped',
            s.t,
            err instanceof Error ? err.message.slice(0, 120) : err,
          ),
        )
    }
  }

  async function onParsed(p: ParseResult, source: 'rtp' | 'response' | 'dom', body?: unknown) {
    // The feed is read twice a minute, so its silence is the sign of a changed site (ADR-002).
    if (p.recognized && p.what === 'feed') {
      lastRecognized = Date.now()
      layoutReported = false
      if (source === 'response') boardAt = lastRecognized
    }
    await onSignals(p.signals, body)
    // Counted when its orders are stored and on their way, so a pass that saw the answer arrive leaves nothing behind.
    if (p.recognized && p.what === 'feed' && source === 'response') {
      board = { seq: (board?.seq ?? 0) + 1, more: p.more === true, total: p.total ?? null }
      if (pass) {
        for (const s of p.signals)
          if (s.t === 'order' && !pass.orders.has(s.order.order_id))
            pass.orders.set(s.order.order_id, pass.pages)
        pass.pages++
      }
    }
  }

  async function boardPassEnd(now = Date.now()) {
    const seen = pass
    pass = null
    // A pass that got no answer of the board (the feed did not open, the board is silent) tells nothing.
    if (!seen || seen.pages === 0) return
    const before = lastPass
    lastPass = seen.orders
    if (!before) return
    // Its last page may lose an order to the next page; the board read to its end loses none.
    const covered = board?.more === false ? Number.POSITIVE_INFINITY : seen.pages - 1
    // What this pass did not reach waits for the next one that does: most passes read only the first pages.
    for (const [orderId, page] of before)
      if (page >= covered && !lastPass.has(orderId)) lastPass.set(orderId, page)
    for (const [orderId, page] of before) {
      if (seen.orders.has(orderId) || page >= covered) continue
      const told = goneAt.get(orderId)
      if (told !== undefined && now - told < GONE_EVERY_MS) continue
      goneAt.delete(orderId)
      if (goneAt.size >= 500) goneAt.delete(goneAt.keys().next().value ?? '')
      goneAt.set(orderId, now)
      await queueEvent(o.db, {
        type: 'profi.order_gone',
        accountId: o.accountId,
        entity: { kind: 'order', id: orderId },
        payload: { page },
      }).catch((err) =>
        console.error(
          'order gone not queued',
          err instanceof Error ? err.message.slice(0, 120) : err,
        ),
      )
    }
  }

  return {
    async onRaw(r) {
      await saveRaw(o.db, {
        accountId: o.accountId,
        kind: r.kind,
        url: r.url,
        body: r.body,
        receivedAt: r.receivedAt,
      })
      const p =
        r.kind === 'rtp'
          ? o.parsers.fromRtp(r.body)
          : r.kind === 'response' && r.url
            ? o.parsers.fromResponse(r.url, r.body)
            : { recognized: false, signals: [] }
      await onParsed(p, r.kind, r.body)
    },
    onParsed,
    async checkSilence(now = Date.now(), active = true) {
      if (!active) {
        lastRecognized = now
        return
      }
      if (layoutReported || now - lastRecognized < silenceMs) return
      layoutReported = true
      await queueEvent(o.db, {
        type: 'profi.layout_changed',
        accountId: o.accountId,
        entity: { kind: 'account', id: o.accountId },
        payload: { what: 'response' },
      })
    },
    lastRecognizedAt: () => lastRecognized,
    knowsOrder,
    chatsTouched: () => [...touched.keys()],
    async knownChats(now = Date.now()) {
      const last = max(rawMessage.sentAt)
      const rows = await o.db
        .select({ chatId: rawMessage.chatId })
        .from(rawMessage)
        .where(
          and(
            eq(rawMessage.accountId, o.accountId),
            gte(rawMessage.sentAt, new Date(now - KNOWN_CHAT_MS).toISOString()),
          ),
        )
        .groupBy(rawMessage.chatId)
        .orderBy(desc(last))
        .limit(3)
      return rows.map((r) => r.chatId)
    },
    async lastStored(chatIds) {
      if (chatIds.length === 0) return new Map()
      const rows = await o.db
        .select({
          chatId: rawMessage.chatId,
          ms: sql<string>`extract(epoch from max(${rawMessage.sentAt})) * 1000`,
        })
        .from(rawMessage)
        .where(and(eq(rawMessage.accountId, o.accountId), inArray(rawMessage.chatId, chatIds)))
        .groupBy(rawMessage.chatId)
      return new Map(rows.map((r) => [r.chatId, Number(r.ms)]))
    },
    async onChatRead(chatId, p) {
      const touch = touched.get(chatId)
      touched.delete(chatId)
      const msgs = p.signals.filter((x): x is MessageSignal => x.t === 'message')
      const known = await o.db
        .select({ id: rawMessage.platformMessageId, sentAt: rawMessage.sentAt })
        .from(rawMessage)
        .where(and(eq(rawMessage.chatId, chatId), eq(rawMessage.accountId, o.accountId)))
      const stored = new Map(known.map((r) => [r.id, Date.parse(r.sentAt)]))
      const quiet = new Set<string>()
      if (known.length === 0) {
        const lastOurs = msgs.findLastIndex((x) => x.message.author === 'specialist')
        for (const x of msgs.slice(0, lastOurs + 1)) quiet.add(x.message.platform_message_id)
      }
      // A message above the last stored one was there before (the page drew it later): history, never news.
      const lastStored = msgs.findLastIndex((x) => stored.has(x.message.platform_message_id))
      for (const x of msgs.slice(0, Math.max(lastStored, 0)))
        if (!stored.has(x.message.platform_message_id)) quiet.add(x.message.platform_message_id)
      // The page shows only HH:MM; the stream's moment is the truer time of the message it named. The chat's order is
      // its time order (M4 design 5.17): history above stored messages goes just before the next stored one, a new
      // message below them never gets a time before the one above it.
      const timeOf = new Map<string, number>()
      msgs.forEach((x, i) => {
        const id = x.message.platform_message_id
        if (stored.has(id) || i >= lastStored) return
        const next = msgs.findIndex((y, j) => j > i && stored.has(y.message.platform_message_id))
        const nextAt = stored.get(msgs[next]?.message.platform_message_id ?? '')
        if (nextAt !== undefined && Number.isFinite(nextAt)) timeOf.set(id, nextAt - (next - i))
      })
      let prev = Math.max(0, ...[...stored.values()].filter(Number.isFinite))
      for (const x of msgs.slice(lastStored + 1)) {
        const id = x.message.platform_message_id
        // The stream named this message, or, when the notice names none, the news in the chat: that moment.
        const named = touch && (touch.messageId === null || id === touch.messageId)
        const seen = Date.parse(named ? touch.at : x.message.sent_at)
        // A broken time stays as it was: that one message fails on its own, the rest of the reading goes on.
        if (!Number.isFinite(seen)) continue
        const at = Math.max(seen, prev + 1)
        prev = at
        timeOf.set(id, at)
      }
      const signals = p.signals.map((x) => {
        const at = x.t === 'message' ? timeOf.get(x.message.platform_message_id) : undefined
        return x.t === 'message' && at !== undefined
          ? { ...x, message: { ...x.message, sent_at: new Date(at).toISOString() } }
          : x
      })
      // A chat the stream never named was found by a sweep.
      await onSignals(signals, undefined, quiet, touch ? 'stream' : 'sweep')
      // The chat's answer may have said the client read a message stored only now: its read goes after its own event.
      const read = msgs.map((x) => x.message.platform_message_id).filter((id) => readIds.has(id))
      if (read.length > 0) await clientRead(read)
    },
    boardWorks: (now = Date.now()) => now - boardAt < 600000,
    board: () => board,
    boardPassStart() {
      pass = { orders: new Map(), pages: 0 }
    },
    boardPassEnd,
    balance: () => balance,
    presence: () => presence,
    reset() {
      lastRecognized = Date.now()
      layoutReported = false
    },
  }
}
