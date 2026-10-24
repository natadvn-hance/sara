import type { Page, WebSocket as PwWebSocket } from 'playwright'
import type { AccountBrowser } from '../browser/accountBrowser'

export type RawRecord = {
  kind: 'rtp' | 'response' | 'dom'
  url: string | null
  body: unknown
  receivedAt: string
}

/** Answers of login and auth pages are never kept: they carry session tokens and the phone (ADR-022). */
const SKIP_PATH = /login|logout|auth|token|oauth|session|sms|password|passport|register|code/i
const SECRET_KEY = /token|password|secret|phone|sms|code|auth|cookie|session/i
// A link parameter that opens something without a login, like «bo_tkn» in the refund link of the profile.
const SECRET_PARAM =
  /([?&][\w-]*(?:tkn|token|key|secret|sig|hash|auth|session)[\w-]*=)[^&#\s"']{8,}/gi

/** Hides values under secret-looking keys, and secret-looking link parameters, anywhere in a recorded answer. */
export function redactSecrets(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(SECRET_PARAM, '$1[скрыто]')
  if (Array.isArray(v)) return v.map(redactSecrets)
  if (typeof v !== 'object' || v === null) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v))
    out[k] = SECRET_KEY.test(k) ? '[скрыто]' : redactSecrets(x)
  return out
}

/**
 * Eyes 1 and 2 (ADR-002): frames of the platform's event stream and the site's JSON answers, taken from the
 * browser's own network layer (CDP). Nothing is injected into the page, so the site's scripts see a plain
 * browser. Nothing is recorded while shouldRecord says no (the session is not working), and nothing is sent.
 */
export async function attachRecorder(
  ab: AccountBrowser,
  o: {
    accountId: string
    rtpHost: string
    profiHosts: string[]
    shouldRecord?: () => boolean
    onRaw(r: RawRecord): Promise<void>
  },
): Promise<void> {
  const allowed = o.shouldRecord ?? (() => true)
  const now = () => new Date().toISOString()
  const hostOk = (host: string) => o.profiHosts.some((h) => host === h || host.endsWith(`.${h}`))

  const watchSocket = (ws: PwWebSocket) => {
    const url = ws.url()
    if (!url.includes(o.rtpHost)) return
    ws.on('framereceived', (f) => {
      if (!allowed() || typeof f.payload !== 'string') return
      let body: unknown = f.payload
      try {
        body = JSON.parse(f.payload)
      } catch {}
      void o
        .onRaw({ kind: 'rtp', url, body: redactSecrets(body), receivedAt: now() })
        .catch(() => {})
    })
  }
  const watchPage = (p: Page) => p.on('websocket', watchSocket)
  for (const p of ab.context.pages()) watchPage(p)
  ab.context.on('page', watchPage)

  ab.context.on('response', async (res) => {
    try {
      if (!allowed()) return
      const u = new URL(res.url())
      if (!hostOk(u.host) || SKIP_PATH.test(u.pathname)) return
      if (!(res.headers()['content-type'] ?? '').includes('json')) return
      await o.onRaw({
        kind: 'response',
        url: res.url(),
        body: redactSecrets(await res.json()),
        receivedAt: now(),
      })
    } catch {}
  })
}
