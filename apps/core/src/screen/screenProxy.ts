import websocket from '@fastify/websocket'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { requireSession } from '../auth/session'

/**
 * The panel's live screen of an account tab (ADR-023): a plain relay to Profi-MCP on the internal
 * network. Nothing from it is stored or logged: Boris types his password and SMS code here.
 */
export async function registerScreenProxy(
  app: FastifyInstance,
  d: { profiScreenUrl: string; nodeToken: string },
): Promise<void> {
  await app.register(websocket)
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)
    scoped.get<{ Params: { id: string } }>(
      '/api/accounts/:id/screen',
      { websocket: true },
      (panel, req) => {
        const upstream = new WebSocket(
          `${d.profiScreenUrl}/screen/${encodeURIComponent(req.params.id)}`,
          {
            headers: { 'x-sara-node-token': d.nodeToken },
          },
        )
        const pending: WebSocket.RawData[] = []
        upstream.on('open', () => {
          for (const m of pending.splice(0)) upstream.send(m)
        })
        upstream.on('message', (m) => panel.readyState === panel.OPEN && panel.send(String(m)))
        upstream.on('close', () => panel.close())
        upstream.on('error', () => panel.close(1011, 'Служба Профи-MCP не отвечает'))
        panel.on('message', (m: WebSocket.RawData) => {
          if (upstream.readyState === upstream.OPEN) upstream.send(m)
          else pending.push(m)
        })
        panel.on('close', () => upstream.close())
      },
    )
  })
}
