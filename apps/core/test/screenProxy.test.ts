import { createServer } from 'node:http'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { registerScreenProxy } from '../src/screen/screenProxy'
import { buildTestApp, type TestApp } from './helpers/app'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)

let t: TestApp
let base: string
let received: string[]
let service: ReturnType<typeof createServer>

beforeEach(async () => {
  await resetDb(db)
  received = []
  service = createServer()
  const wss = new WebSocketServer({ noServer: true })
  service.on('upgrade', (req, socket, head) => {
    if (req.headers['x-sara-node-token'] !== 'node-tok' || req.url !== '/screen/hance-marketing') {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ frame: 'AAAA', w: 10, h: 10 }))
      ws.on('message', (m) => received.push(String(m)))
    })
  })
  await new Promise<void>((r) => service.listen(0, '127.0.0.1', r))
  const port = (service.address() as { port: number }).port
  t = await buildTestApp(db)
  await registerScreenProxy(t.app, {
    profiScreenUrl: `ws://127.0.0.1:${port}`,
    nodeToken: 'node-tok',
  })
  await t.app.inject({
    method: 'POST',
    url: '/api/setup/password',
    payload: { password: 'длинныйпароль1' },
  })
  base = (await t.app.listen({ port: 0, host: '127.0.0.1' })).replace('http', 'ws')
})
afterEach(async () => {
  await t.close()
  service.closeAllConnections()
  await new Promise<void>((r) => service.close(() => r()))
})

function open(cookie: string | null): Promise<WebSocket> {
  const ws = new WebSocket(`${base}/api/accounts/hance-marketing/screen`, {
    headers: cookie ? { cookie } : {},
  })
  return new Promise((ok, fail) => {
    ws.on('open', () => ok(ws))
    ws.on('unexpected-response', (_q, res) => fail(new Error(`status ${res.statusCode}`)))
    ws.on('error', fail)
  })
}

describe('live screen proxy', () => {
  it('FR-SET-4: the panel gets frames from the service and sends taps back', async () => {
    const got: string[] = []
    const ws = await open(t.cookie())
    ws.on('message', (m) => got.push(String(m)))
    await expect.poll(() => got.length).toBeGreaterThan(0)
    expect(JSON.parse(got[0] ?? '{}')).toMatchObject({ frame: 'AAAA' })
    ws.send(JSON.stringify({ t: 'text', text: '1' }))
    await expect.poll(() => received).toEqual(['{"t":"text","text":"1"}'])
    ws.close()
  })

  it('T11: the live screen without a panel session is refused', async () => {
    await expect(open(null)).rejects.toThrow(/401/)
  })
})
