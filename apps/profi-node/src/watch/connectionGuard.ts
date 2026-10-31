import { and, desc, sql } from 'drizzle-orm'
import type { NodeDb } from '../db/client'
import { outboxNode } from '../db/schema'
import { queueEvent } from '../ship/outbox'

export type ConnectionGuard = {
  /** The result of a real page load of the site (from the minute check); no extra probes. */
  report(ok: boolean, now?: number): Promise<void>
  /** Online: yes. Offline: only once per retry interval, so the site is not hammered (ADR-021). */
  mayNavigate(now?: number): boolean
  tick(now?: number): Promise<void>
  online(): boolean
}

/**
 * Profi.ru unreachable (ADR-021, as v1): touch the site once per 5 minutes; one 🌐 after 30 minutes and one when
 * it is back; after any outage a reconcile, so nothing written meanwhile is lost. A «lost» already sent outlives a
 * restart: the node's own queue keeps it, so the first page that opens after the restart sends the «back».
 */
export function createConnectionGuard(o: {
  db: NodeDb
  accountId: string
  onBack(since: string): Promise<void>
  retryMs?: number
  alarmAfterMs?: number
}): ConnectionGuard {
  const retryMs = o.retryMs ?? 300000
  const alarmAfterMs = o.alarmAfterMs ?? 1800000
  let isOnline = true
  let lostSince: number | null = null
  let lostSent = false
  let lastTry = Number.NEGATIVE_INFINITY
  const entity = { kind: 'account', id: o.accountId }

  // On 29.10.2026 every deploy restarted the node during an outage: it forgot the «lost» it had sent, never sent the
  // «back», and the pult showed «Нет связи» for days. The last lost or back of the account in the queue is the truth.
  // Read once at the start; a report waits for it only if it comes first, else it stays as quick as before.
  let restored = false
  const restoring = (async () => {
    const [last] = await o.db
      .select({
        type: sql<string>`${outboxNode.payload}->>'type'`,
        since: sql<string>`${outboxNode.payload}->'payload'->>'since'`,
      })
      .from(outboxNode)
      .where(
        and(
          sql`${outboxNode.payload}->>'account_id' = ${o.accountId}`,
          sql`${outboxNode.payload}->>'type' in ('profi.connection_lost', 'profi.connection_back')`,
        ),
      )
      .orderBy(desc(sql`${outboxNode.payload}->>'occurred_at'`))
      .limit(1)
    if (last?.type !== 'profi.connection_lost') return
    isOnline = false
    lostSince = Date.parse(last.since)
    lostSent = true
  })()
    .catch(() => {})
    .finally(() => {
      restored = true
    })
  async function alarmIfLong(now: number) {
    if (isOnline || lostSent || lostSince === null || now - lostSince < alarmAfterMs) return
    lostSent = true
    await queueEvent(o.db, {
      type: 'profi.connection_lost',
      accountId: o.accountId,
      entity,
      payload: { since: new Date(lostSince).toISOString() },
    })
  }

  return {
    online: () => isOnline,
    mayNavigate: (now = Date.now()) => isOnline || now - lastTry >= retryMs,
    async report(ok, now = Date.now()) {
      if (!restored) await restoring
      lastTry = now
      if (!ok) {
        if (isOnline) {
          isOnline = false
          lostSince = now
        }
        await alarmIfLong(now)
        return
      }
      if (isOnline) return
      const since = new Date(lostSince ?? now).toISOString()
      isOnline = true
      if (lostSent) {
        await queueEvent(o.db, {
          type: 'profi.connection_back',
          accountId: o.accountId,
          entity,
          payload: { since },
        })
      }
      lostSince = null
      lostSent = false
      await o.onBack(since)
    },
    async tick(now = Date.now()) {
      if (!restored) await restoring
      await alarmIfLong(now)
    },
  }
}
