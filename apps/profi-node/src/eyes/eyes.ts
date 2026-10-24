import { and, desc, eq, gte, max } from 'drizzle-orm'
import type { NodeDb } from '../db/client'
import { rawMessage, rawOrder } from '../db/schema'
import { queueEvent } from '../ship/outbox'
import { saveRaw, upsertMessage, upsertOrder } from '../store/raw'
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
   * A chat page was read. On the first reading of a chat only the client's messages after our last one are news;
   * what came before is history from before Sara watched, kept without events.
   */
  onChatRead(chatId: string, p: ParseResult): Promise<void>
  /** The site's board answer was read in the last 10 minutes. */
  boardWorks(now?: number): boolean
  /**
   * The board answers read so far: how many (a counter, to tell a new one from the last) and whether the last one
   * said the board has more pages. Null before the first. The minute check scrolls the board by it.
   */
  board(): { seq: number; more: boolean } | null
  presence(): boolean
  reset(): void
}

// Old Sara's line between a live chat and an old one (v1, OLD_ESCALATION_AFTER_MS).
const KNOWN_CHAT_MS = 3 * 24 * 3600 * 1000

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
  let board: { seq: number; more: boolean } | null = null
  // chat → when the stream named it and which message, for the time the message really came.
  const touched = new Map<string, { at: string; messageId: string | null }>()

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

  async function onSignals(
    signals: Signal[],
    body: unknown,
    quiet: Set<string> = new Set(),
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
          if (!isNew || history || m.author === 'specialist' || m.author === 'system') return
          await queueEvent(tx, {
            type: m.author === 'client' ? 'profi.client_message' : 'profi.author_unclear',
            accountId: o.accountId,
            entity: { kind: 'chat', id: m.chat_id },
            payload: {
              chat_id: m.chat_id,
              order_id: m.order_id,
              platform_message_id: m.platform_message_id,
              sent_at: m.sent_at,
              author: m.author,
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
    // The feed is read every minute, so its silence is the sign of a changed site (ADR-002).
    if (p.recognized && p.what === 'feed') {
      lastRecognized = Date.now()
      layoutReported = false
      if (source === 'response') boardAt = lastRecognized
    }
    await onSignals(p.signals, body)
    // Counted when its orders are stored and on their way, so a pass that saw the answer arrive leaves nothing behind.
    if (p.recognized && p.what === 'feed' && source === 'response')
      board = { seq: (board?.seq ?? 0) + 1, more: p.more === true }
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
    async onChatRead(chatId, p) {
      const touch = touched.get(chatId)
      touched.delete(chatId)
      const msgs = p.signals.filter((x): x is MessageSignal => x.t === 'message')
      const known = await o.db
        .select({ id: rawMessage.platformMessageId })
        .from(rawMessage)
        .where(and(eq(rawMessage.chatId, chatId), eq(rawMessage.accountId, o.accountId)))
        .limit(1)
      const quiet = new Set<string>()
      if (known.length === 0) {
        const lastOurs = msgs.findLastIndex((x) => x.message.author === 'specialist')
        for (const x of msgs.slice(0, lastOurs + 1)) quiet.add(x.message.platform_message_id)
      }
      // The page shows only HH:MM; the stream's moment is the truer time of the message it named.
      const signals = p.signals.map((x) =>
        x.t === 'message' && touch && x.message.platform_message_id === touch.messageId
          ? { ...x, message: { ...x.message, sent_at: touch.at } }
          : x,
      )
      await onSignals(signals, undefined, quiet)
    },
    boardWorks: (now = Date.now()) => now - boardAt < 600000,
    board: () => board,
    balance: () => balance,
    presence: () => presence,
    reset() {
      lastRecognized = Date.now()
      layoutReported = false
    },
  }
}
