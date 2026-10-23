import type { Server as HttpServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import type { AccountBrowser } from '../browser/accountBrowser'
import { applyInput, startLiveScreen } from './liveScreen'

const Input = z.discriminatedUnion('t', [
  z.object({ t: z.literal('click'), x: z.number(), y: z.number() }),
  z.object({ t: z.literal('scroll'), dy: z.number() }),
  z.object({ t: z.literal('key'), key: z.string().min(1).max(30) }),
  z.object({ t: z.literal('text'), text: z.string().max(200) }),
])

/** WebSocket /screen/:accountId on the internal network only; the core proxies it to the panel (T4). */
export function registerScreenRoute(
  http: HttpServer,
  d: {
    nodeToken: string
    browsers: Map<string, AccountBrowser>
    /** How many people watch the account's screen; the service leaves the tab alone meanwhile. */
    onViewers?: (accountId: string, n: number) => void
    /** False on a wrong IP: the screen is shown, but no taps or keys reach the site (FR-ACC-1). */
    allowInput?: (accountId: string) => boolean
  },
): void {
  const viewers = new Map<string, number>()
  const count = (id: string, delta: number) => {
    const n = Math.max(0, (viewers.get(id) ?? 0) + delta)
    viewers.set(id, n)
    d.onViewers?.(id, n)
  }
  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    const m = /^\/screen\/([^/?]+)/.exec(req.url ?? '')
    if (!m) return socket.destroy()
    if (req.headers['x-sara-node-token'] !== d.nodeToken) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    const accountId = decodeURIComponent(m[1] ?? '')
    const ab = d.browsers.get(accountId)
    if (!ab) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      count(accountId, 1)
      // Input is taken from the first moment, so nothing the panel sent at once is lost.
      ws.on('message', (raw) => {
        if (d.allowInput && !d.allowInput(accountId)) return
        let data: unknown = null
        try {
          data = JSON.parse(String(raw))
        } catch {}
        const parsed = Input.safeParse(data)
        if (parsed.success) void applyInput(ab.page, parsed.data).catch(() => {})
      })
      let stop: (() => Promise<void>) | null = null
      let closed = false
      ws.on('close', () => {
        closed = true
        count(accountId, -1)
        void stop?.()
      })
      startLiveScreen(ab.page, (frame, w, h) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ frame, w, h }))
      })
        .then((s) => {
          stop = s
          if (closed) void s()
        })
        .catch(() => ws.close(1011, 'Экран вкладки недоступен'))
    })
  })
}
