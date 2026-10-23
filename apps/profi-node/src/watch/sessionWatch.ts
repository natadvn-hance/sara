import type { Page } from 'playwright'
import type { NodeDb } from '../db/client'
import { ProfiToolError } from '../mcp/server'
import { queueEvent } from '../ship/outbox'

export type SessionState = 'alive' | 'dead' | 'banned' | 'unknown'

/** What the tab shows now: the login page, a ban notice, or a working cabinet. */
export async function detectSessionState(page: Page, banMarkers: string[]): Promise<SessionState> {
  try {
    const url = page.url()
    if (!url.startsWith('http')) return 'unknown'
    const title = await page.title()
    if (/\/login/.test(new URL(url).pathname) || title.includes('Вход на Профи.ру')) return 'dead'
    const text = await page.locator('body').innerText({ timeout: 2000 })
    if (banMarkers.some((m) => text.includes(m))) return 'banned'
    return 'alive'
  } catch {
    return 'unknown'
  }
}

export type SessionWatch = {
  start(): void
  stop(): void
  tick(now?: number): Promise<void>
  state(): SessionState
}

/**
 * Sends one event per change of the login state (FR-OPS-2): one 🚨 for a logout or a ban, one 🟢 when the
 * session is back, and asks for a reconcile of what came while it was down (F8).
 */
export function createSessionWatch(o: {
  accountId: string
  page: Page
  db: NodeDb
  banMarkers: string[]
  intervalMs?: number
  onAlive(deadSince: string): void
  /** The tab could not be read at all for stuckAfterMs (crashed or hung browser). */
  onStuck?: () => void
  stuckAfterMs?: number
}): SessionWatch {
  const stuckAfterMs = o.stuckAfterMs ?? 300000
  let unknownSince: number | null = null
  let stuckReported = false
  let current: SessionState = 'unknown'
  let downSince: string | null = null
  let timer: NodeJS.Timeout | null = null
  const entity = { kind: 'account', id: o.accountId }

  async function tick(now = Date.now()): Promise<void> {
    const next = await detectSessionState(o.page, o.banMarkers)
    if (next === 'unknown') {
      unknownSince ??= now
      if (!stuckReported && now - unknownSince >= stuckAfterMs) {
        stuckReported = true
        o.onStuck?.()
      }
      return
    }
    unknownSince = null
    stuckReported = false
    if (next === current) return
    const prev = current
    current = next
    if (next === 'dead' || next === 'banned') {
      downSince = downSince ?? new Date().toISOString()
      await queueEvent(o.db, {
        type: next === 'dead' ? 'profi.session_dead' : 'profi.profile_banned',
        accountId: o.accountId,
        entity,
        payload: {},
      })
      return
    }
    if (prev === 'dead' || prev === 'banned') {
      const since = downSince ?? new Date().toISOString()
      downSince = null
      await queueEvent(o.db, {
        type: 'profi.session_alive',
        accountId: o.accountId,
        entity,
        payload: { dead_since: since },
      })
      o.onAlive(since)
    }
  }

  return {
    start() {
      timer ??= setInterval(() => void tick().catch(() => {}), o.intervalMs ?? 60000)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
    state: () => current,
  }
}

/** Every tool of an account checks this first: nothing is done on a dead or banned session. */
export function requireAlive(w: Pick<SessionWatch, 'state'>): void {
  const s = w.state()
  if (s === 'dead') throw new ProfiToolError('SESSION_DEAD', 'Профи.ру разлогинил аккаунт')
  if (s === 'banned') throw new ProfiToolError('BANNED', 'Профи.ру заблокировал профиль')
}
