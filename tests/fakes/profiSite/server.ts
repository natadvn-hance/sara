// Stand-in Profi.ru for the engine tests (ADR-017): login, feed, order, chats, an __RTP-like stream.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { type WebSocket, WebSocketServer } from 'ws'
import {
  bannedPage,
  CHANGED_LAYOUT,
  chatPage,
  chatsPage,
  feedPage,
  type Layout,
  loginPage,
  NORMAL_LAYOUT,
  orderPage,
} from './pages'

export type SiteOrder = {
  id: string
  subject: string
  category: string
  city: string
  description: string
  clientName: string
  budget: string | null
  price: number
  publishedAt: string
  open: boolean
}
export type SiteAuthor = 'client' | 'specialist' | 'system' | 'strange'
export type SiteMessage = { id: string; side: SiteAuthor; text: string; ts: string; read: boolean }

export type ProfiSite = {
  url: string
  rtpUrl: string
  rtpHost: string
  code: string
  balance: number
  orders: SiteOrder[]
  addOrder(o?: Partial<SiteOrder>): string
  addMessage(chatId: string, author: SiteAuthor, text: string): string
  logout(): void
  ban(): void
  offline(on: boolean): void
  muteRtp(on: boolean): void
  changeLayout(): void
  close(): Promise<void>
}

let seq = 90000000

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok) => {
    let b = ''
    req.on('data', (c) => {
      b += c
    })
    req.on('end', () => ok(b))
  })
}

export async function startProfiSite(o: { port?: number } = {}): Promise<ProfiSite> {
  const sessions = new Set<string>()
  const orders: SiteOrder[] = []
  const chats = new Map<string, SiteMessage[]>()
  const sockets = new Set<Socket>()
  let banned = false
  let isOffline = false
  let rtpMuted = false
  let layout: Layout = NORMAL_LAYOUT
  const code = String(100000 + Math.floor(Math.random() * 899999))
  const state = { balance: 5000 }

  const sessOf = (req: IncomingMessage) => /sess=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
  const html = (res: ServerResponse, body: string) =>
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(body.replaceAll('__BALANCE__', String(state.balance)).replaceAll('__PRESENCE__', 'on'))
  const json = (res: ServerResponse, body: unknown, status = 200) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

  const rtpServer = createServer()
  const wss = new WebSocketServer({ server: rtpServer, path: '/rtp' })
  const clients = new Set<WebSocket>()
  wss.on('connection', (ws, req) => {
    const sess = new URL(req.url ?? '', 'http://x').searchParams.get('sess') ?? sessOf(req)
    if (!sessions.has(sess)) return ws.close()
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
  })
  const push = (msg: unknown) => {
    if (rtpMuted) return
    for (const c of clients) c.send(JSON.stringify(msg))
  }

  const site = createServer(async (req, res) => {
    if (isOffline) return req.socket.destroy()
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname
    // Echo of the caller's IP, standing in for an outside service like ipify (no login needed).
    if (p === '/ip') return res.writeHead(200).end(req.socket.remoteAddress ?? '')
    if (p === '/login' && req.method === 'GET') return html(res, loginPage())
    if (p === '/login/phone') return json(res, { sent: true })
    if (p === '/login/code') {
      const body = JSON.parse((await readBody(req)) || '{}') as { code?: string }
      if (body.code !== code) return json(res, { error: 'bad code' }, 400)
      const s = randomBytes(8).toString('hex')
      sessions.add(s)
      res.setHeader('set-cookie', `sess=${s}; Path=/`)
      return json(res, { ok: true })
    }
    if (!sessions.has(sessOf(req))) {
      if (p.startsWith('/api/')) return json(res, { error: 'unauthorized' }, 401)
      return res.writeHead(302, { location: '/login' }).end()
    }
    if (banned) return html(res, bannedPage())
    if (p === '/api/feed') return json(res, { [layout.feedKey]: orders.filter((x) => x.open) })
    if (p.startsWith('/api/order/')) {
      const found = orders.find((x) => x.id === p.slice('/api/order/'.length))
      return found ? json(res, found) : json(res, { error: 'not found' }, 404)
    }
    if (p === '/api/chats') {
      return json(res, {
        chats: [...chats].map(([id, m]) => ({
          id,
          unread: m.filter((x) => !x.read).length,
          last: m.at(-1)?.ts ?? null,
        })),
      })
    }
    if (p.startsWith('/api/chat/'))
      return json(res, { messages: chats.get(p.slice('/api/chat/'.length)) ?? [] })
    if (p === '/backoffice/a.php') return html(res, feedPage(rtp.url, layout))
    if (p === '/backoffice/n.php') return html(res, orderPage(url.searchParams.get('o') ?? ''))
    if (p === '/chats') return html(res, chatsPage())
    if (p.startsWith('/chats/'))
      return html(res, chatPage(rtp.url, p.slice('/chats/'.length), layout))
    res.writeHead(404).end()
  })
  site.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  const listen = (s: ReturnType<typeof createServer>, port: number, host: string) =>
    new Promise<number>((ok) =>
      s.listen(port, host, () => ok((s.address() as { port: number }).port)),
    )
  const sitePort = await listen(site, o.port ?? 0, '127.0.0.1')
  const rtpPort = await listen(rtpServer, 0, '::1')
  // The site on 127.0.0.1 and the stream on [::1]: two hosts, like profi.ru and online.profi.ru.
  const rtp = { url: `ws://[::1]:${rtpPort}`, host: `[::1]:${rtpPort}` }

  return {
    url: `http://127.0.0.1:${sitePort}`,
    rtpUrl: rtp.url,
    rtpHost: rtp.host,
    code,
    get balance() {
      return state.balance
    },
    orders,
    addOrder(partial = {}) {
      const id = partial.id ?? String(++seq)
      const order: SiteOrder = {
        id,
        subject: 'Сайт для клиники',
        category: 'Создание сайтов',
        city: 'Краснодар',
        description: 'Нужен сайт с онлайн-записью',
        clientName: 'Ирина',
        budget: 'до 150 000 ₽',
        price: 210,
        publishedAt: new Date().toISOString(),
        open: true,
        ...partial,
      }
      orders.unshift(order)
      push({ type: 'order.new', order })
      return id
    },
    addMessage(chatId, author, text) {
      const id = `m${++seq}`
      const m: SiteMessage = { id, side: author, text, ts: new Date().toISOString(), read: false }
      chats.set(chatId, [...(chats.get(chatId) ?? []), m])
      push({ type: 'message.new', chatId, message: m })
      return id
    },
    logout() {
      sessions.clear()
      for (const c of clients) c.close()
    },
    ban() {
      banned = true
    },
    offline(on) {
      isOffline = on
      if (on) {
        for (const s of sockets) s.destroy()
        for (const c of clients) c.terminate()
      }
    },
    muteRtp(on) {
      rtpMuted = on
    },
    changeLayout() {
      layout = CHANGED_LAYOUT
    },
    async close() {
      for (const c of clients) c.terminate()
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => wss.close(() => r()))
      await new Promise<void>((r) => rtpServer.close(() => r()))
      await new Promise<void>((r) => site.close(() => r()))
    },
  }
}
