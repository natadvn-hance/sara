import type { AccountBrowser } from '../browser/accountBrowser'
import type { NodeDb } from '../db/client'
import { queueEvent } from '../ship/outbox'

/** Can the account's tab reach the site at all? A short-lived tab, same proxy, the live tab undisturbed. */
export async function probeSite(ab: AccountBrowser, baseUrl: string): Promise<boolean> {
  const p = await ab.context.newPage()
  try {
    const res = await p.goto(baseUrl, { timeout: 15000, waitUntil: 'domcontentloaded' })
    return (res?.status() ?? 0) < 500
  } catch {
    return false
  } finally {
    await p.close().catch(() => {})
  }
}

export type ConnectionGuard = { tick(now?: number): Promise<void>; online(): boolean }

/**
 * Profi.ru unreachable (ADR-021, as v1): ask the site once per 5 minutes, not every chat at once; one 🌐 after
 * 30 minutes and one when it is back; after any outage a reconcile, so nothing written meanwhile is lost.
 */
export function createConnectionGuard(o: {
  db: NodeDb
  accountId: string
  probe(): Promise<boolean>
  onBack(since: string): Promise<void>
  onlineCheckMs?: number
  retryMs?: number
  alarmAfterMs?: number
}): ConnectionGuard {
  const onlineCheckMs = o.onlineCheckMs ?? 60000
  const retryMs = o.retryMs ?? 300000
  const alarmAfterMs = o.alarmAfterMs ?? 1800000
  let isOnline = true
  let lostSince: number | null = null
  let lostSent = false
  let lastProbe = Number.NEGATIVE_INFINITY
  const entity = { kind: 'account', id: o.accountId }

  return {
    online: () => isOnline,
    async tick(now = Date.now()) {
      if (now - lastProbe < (isOnline ? onlineCheckMs : retryMs)) {
        await alarmIfLong(now)
        return
      }
      lastProbe = now
      const ok = await o.probe()
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
  }

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
}
