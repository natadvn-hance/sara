import type { AccountBrowser } from '../browser/accountBrowser'

export type RawRecord = {
  kind: 'rtp' | 'response' | 'dom'
  url: string | null
  body: unknown
  receivedAt: string
}

/**
 * Eyes 1 and 2 (ADR-002): every message of the platform's event stream (window.__RTP from the stream host)
 * and every JSON answer of the site go to onRaw as they arrive. Nothing is sent to the site.
 */
export async function attachRecorder(
  ab: AccountBrowser,
  o: {
    accountId: string
    rtpHost: string
    profiHosts: string[]
    onRaw(r: RawRecord): Promise<void>
  },
): Promise<void> {
  const now = () => new Date().toISOString()
  await ab.context.exposeBinding('__saraRtp', (_src, url: string, data: string) => {
    let body: unknown = data
    try {
      body = JSON.parse(data)
    } catch {}
    void o.onRaw({ kind: 'rtp', url, body, receivedAt: now() }).catch(() => {})
  })
  await ab.context.addInitScript((rtpHost: string) => {
    const Native = window.WebSocket
    // Looked up per message: the binding may appear after this script runs.
    const send = (u: string, d: string) =>
      (window as unknown as { __saraRtp?: (u: string, d: string) => void }).__saraRtp?.(u, d)
    class Watched extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const u = String(url)
        if (u.includes(rtpHost)) {
          this.addEventListener('message', (m) => {
            if (typeof m.data === 'string') send(u, m.data)
          })
        }
      }
    }
    window.WebSocket = Watched
  }, o.rtpHost)
  ab.context.on('response', async (res) => {
    try {
      const url = res.url()
      if (!o.profiHosts.includes(new URL(url).host)) return
      if (!(res.headers()['content-type'] ?? '').includes('json')) return
      await o.onRaw({ kind: 'response', url, body: await res.json(), receivedAt: now() })
    } catch {}
  })
}
