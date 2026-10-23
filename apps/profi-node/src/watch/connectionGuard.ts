import type { NodeDb } from '../db/client'
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
 * it is back; after any outage a reconcile, so nothing written meanwhile is lost.
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
    tick: (now = Date.now()) => alarmIfLong(now),
  }
}
