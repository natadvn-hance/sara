import { and, eq } from 'drizzle-orm'
import type { NodeDb } from '../db/client'
import { rawOrder } from '../db/schema'
import { queueEvent } from '../ship/outbox'
import { saveRaw, upsertMessage, upsertOrder } from '../store/raw'
import type { OrderSignal, ParseResult, Parsers, Signal } from './parsers'
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
  /** Orders seen on the board whose page has not been read yet, oldest first. */
  ordersWantingPage(): string[]
  /** The order's page could not be read: the order goes out with what the board showed. */
  settleOrder(orderId: string): Promise<void>
  presence(): boolean
  reset(): void
}

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
  // Board orders lack the fee, which only their page shows; bounded so a stuck tab cannot grow it.
  const waiting = new Map<string, OrderSignal>()
  const WAITING_MAX = 100

  async function knowsOrder(orderId: string): Promise<boolean> {
    const rows = await o.db
      .select({ id: rawOrder.orderId })
      .from(rawOrder)
      .where(and(eq(rawOrder.orderId, orderId), eq(rawOrder.accountId, o.accountId)))
      .limit(1)
    return rows.length > 0
  }

  /** A page reading completes the board one: the board's text and budget, the page's fee. */
  function withBoard(s: OrderSignal): OrderSignal {
    const b = waiting.get(s.order.order_id)
    if (!b) return s
    waiting.delete(s.order.order_id)
    return {
      t: 'order',
      order: {
        ...b.order,
        budget_text: b.order.budget_text ?? s.order.budget_text,
        bid_price_rub: s.order.bid_price_rub || b.order.bid_price_rub,
      },
      published_at: b.published_at ?? s.published_at,
    }
  }

  async function onSignals(signals: Signal[], body: unknown): Promise<void> {
    for (const raw of signals) {
      let s = raw
      if (s.t === 'order' && s.needsPage) {
        const id = s.order.order_id
        if (!waiting.has(id) && waiting.size < WAITING_MAX && !(await knowsOrder(id)))
          waiting.set(id, s)
        continue
      }
      if (s.t === 'order') s = withBoard(s)
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
              body: { ...s.order, published_at: s.published_at },
            })
            if (!isNew) return
            await queueEvent(tx, {
              type: 'profi.order_seen',
              accountId: o.accountId,
              entity: { kind: 'order', id: s.order.order_id },
              payload: s.order,
            })
            return
          }
          const m = s.message
          const isNew = await upsertMessage(tx, { accountId: o.accountId, message: m })
          if (!isNew || m.author === 'specialist' || m.author === 'system') return
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

  async function onParsed(p: ParseResult, _source: 'rtp' | 'response' | 'dom', body?: unknown) {
    // The feed is read every minute, so its silence is the sign of a changed site (ADR-002).
    if (p.recognized && p.what === 'feed') {
      lastRecognized = Date.now()
      layoutReported = false
    }
    await onSignals(p.signals, body)
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
    ordersWantingPage: () => [...waiting.keys()],
    async settleOrder(orderId) {
      const b = waiting.get(orderId)
      if (!b) return
      waiting.delete(orderId)
      await onSignals([{ ...b, needsPage: false }], undefined)
    },
    balance: () => balance,
    presence: () => presence,
    reset() {
      lastRecognized = Date.now()
      layoutReported = false
    },
  }
}
