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
  d: { nodeToken: string; browsers: Map<string, AccountBrowser> },
): void {
  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    const m = /^\/screen\/([^/?]+)/.exec(req.url ?? '')
    if (!m) return socket.destroy()
    if (req.headers['x-sara-node-token'] !== d.nodeToken) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    const ab = d.browsers.get(decodeURIComponent(m[1] ?? ''))
    if (!ab) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      const stop = await startLiveScreen(ab.page, (frame, w, h) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ frame, w, h }))
      })
      ws.on('message', (raw) => {
        const parsed = Input.safeParse(
          (() => {
            try {
              return JSON.parse(String(raw))
            } catch {
              return null
            }
          })(),
        )
        if (parsed.success) void applyInput(ab.page, parsed.data).catch(() => {})
      })
      ws.on('close', () => void stop())
    })
  })
}
