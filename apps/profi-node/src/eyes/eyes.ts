import type { NodeDb } from '../db/client'
import { queueEvent } from '../ship/outbox'
import { saveRaw, upsertMessage, upsertOrder } from '../store/raw'
import type { ParseResult, Parsers, Signal } from './parsers'
import type { RawRecord } from './recorder'

export type Eyes = {
  onRaw(r: RawRecord): Promise<void>
  onParsed(p: ParseResult, source: 'rtp' | 'response' | 'dom', body?: unknown): Promise<void>
  /** active: the account is working (logged in, online, own IP); otherwise the silence clock restarts. */
  checkSilence(now?: number, active?: boolean): Promise<void>
  lastRecognizedAt(): number
  balance(): number | null
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

  async function onSignals(signals: Signal[], body: unknown): Promise<void> {
    for (const s of signals) {
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
    balance: () => balance,
    presence: () => presence,
    reset() {
      lastRecognized = Date.now()
      layoutReported = false
    },
  }
}
