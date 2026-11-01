// Stand-in Profi.ru for the engine tests (ADR-017): login, feed, order, chats, an __RTP-like stream.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { type WebSocket, WebSocketServer } from 'ws'
import {
  type BidLook,
  type BoardLayout,
  bannedPage,
  CHANGED_LAYOUT,
  chatPage,
  chatsPage,
  feedPage,
  type Layout,
  loginPage,
  NORMAL_LAYOUT,
  orderPage,
  widgetPage,
} from './pages'

/** What the client of an order shows on the page: the backoffice answer getKlientInfo is drawn from it. */
export type SiteKlient = {
  name: string
  title: string
  verified: boolean
  positive: number
  negative: number
  tags: string[]
  /** The site's own lines about the client (Profi Pro), as the answer writes them. */
  summaries?: { image: string; colorTheme: string; description: string; renderInOrder: boolean }[]
}
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
  /** This account already bid on the order. */
  hasBid: boolean
  /** The form will not take a bid without «Стоимость услуги». */
  priceRequired: boolean
  /** The order page answers as for an order the client closed, read live: no form, tariff or price, no closed mark. */
  bare?: boolean
  /** The client as getKlientInfo shows them; null: the site has no answer for this order. */
  klient: SiteKlient | null
}
/** A bid the form sent; priceTo only when the form sent a «До». */
export type SiteBid = { orderId: string; price: string; text: string; priceTo?: string }
/** How the bid form behaves: ok, silent (refused, the form stays), lost (the form closes, no bid on the order). */
export type BidSettings = BidLook & {
  mode: 'ok' | 'silent' | 'lost'
  /** The order page gets its answer at all. */
  answer: boolean
  /** The answer says hasBid (a renamed field would not). */
  hasBidField: boolean
  /** The top bar shows the wallet. */
  showWallet: boolean
  /** The opener's words, in the answer (tariffsBlock.scrollButtonText) and on the page. */
  openerText: string
  /** The client answer (getKlientInfo) comes this late, in ms. */
  klientDelayMs: number
  /** An open order shows its bid form; false is a changed layout: no form, and no «closed» mark either. */
  formShown: boolean
  /** After a bid is taken, this many order answers still say there is none: the site's data catching up. */
  hasBidLag: number
  /** The send of a bid is answered this late, in ms: the form stays open meanwhile. */
  postDelayMs: number
  /** The top bar shows this wallet whatever was spent (a bar not refreshed yet); null: the real one. */
  barBalance: number | null
  /** A bid the site took stands in the order's chat, with the site's tail after it, as live; this late, in ms. */
  chatBid: boolean
  chatBidDelayMs: number
}
export type SiteAuthor = 'client' | 'specialist' | 'system' | 'strange'
export type SiteMessage = { id: string; side: SiteAuthor; text: string; ts: string; read: boolean }

export type ProfiSite = {
  url: string
  rtpUrl: string
  rtpHost: string
  code: string
  balance: number
  /** Presses of what opens the bid form on an order page: the eyes never press it. */
  openerClicks: number
  /** Bids the form sent and the site took. */
  bids: SiteBid[]
  /** Presses of the send button that reached the site, taken or not. */
  bidPosts: number
  /** Requests for the board (/api/feed), the first page and the following ones. */
  feedRequests: number
  /** The board gives this many orders to a page and the rest by cursor, as the live one does; 0: all at once. */
  boardPageSize: number
  /** How the feed page loads the rest of a long board (see BoardLayout); the wheel over the window by default. */
  boardLayout: BoardLayout
  bidSettings: BidSettings
  setBalance(rub: number): void
  /** Back to a fresh form: no bids, 5000 ₽, the wallet pays, the answer comes. */
  resetBids(): void
  orders: SiteOrder[]
  addOrder(o?: Partial<SiteOrder>): string
  addMessage(chatId: string, author: SiteAuthor, text: string): string
  logout(): void
  ban(): void
  offline(on: boolean): void
  /** Pages hold a request that never ends, so «load» never fires (Profi.ru since 29.10.2026). */
  hangLoad(on: boolean): void
  /** Pages ask before they are left, as a page with a filled form does once the user has clicked in it. */
  askBeforeLeave(on: boolean): void
  /** The next `n` page requests are cut off before any answer, as one lost request is. */
  dropNext(n: number): void
  muteRtp(on: boolean): void
  /** The stream only names the chat with news and the message number, as the live one does; the words are on its page. */
  streamNamesOnly(on: boolean): void
  changeLayout(): void
  close(): Promise<void>
}

let seq = 90000000

const DECOY: SiteKlient = {
  name: 'Чужой',
  title: 'На Профи.ру с 1 января 2019',
  verified: false,
  positive: 0,
  negative: 9,
  tags: ['Не платит'],
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok) => {
    let b = ''
    req.on('data', (c) => {
      b += c
    })
    req.on('end', () => ok(b))
  })
}

const COMMENT_PLACEHOLDER =
  'Расскажите о своём опыте. Опишите, как будете решать задачу клиента, прокомментируйте цену.'

/** The order page answer in the shape of the live one (tests/fixtures/profi/response/order-page.json). */
function orderScreen(o: SiteOrder, s: BidSettings) {
  // An order the client closed (order 95385373, read live): only what the page shows, nothing to bid with.
  if (o.bare)
    return {
      id: o.id,
      ...(s.hasBidField && { hasBid: o.hasBid }),
      badges: [],
      params: [],
      gallery: null,
      markers: [],
      subject: o.subject,
      documents: [],
      duplicates: [],
      analyticsData: {},
    }
  const fee = String(o.price)
  const submit = { text: 'Откликнуться', style: 'PRIMARY' }
  return {
    id: o.id,
    ...(s.hasBidField && { hasBid: o.hasBid }),
    price: { value: fee, baseValue: fee, bidPromoType: null, currencySymbol: '₽' },
    disabledBidBlock: o.open ? null : { title: 'Заказ закрыт' },
    tariffsBlock: {
      label: 'Тариф',
      details: 'Детали',
      formTitle: 'Комиссия за заказ',
      scrollButtonText: s.openerText,
      defaultTariffType: 'LEADGEN',
      tariffs: [
        { type: 'LEADGEN', title: 'Отклик', price: { value: `${fee} ₽`, currencySymbol: '₽' } },
      ],
    },
    form:
      o.open && s.formShown
        ? {
            buttons: { refuse: null, submit },
            elements: {
              amount: {
                name: 'stavka',
                type: 'INPUT',
                label: 'Стоимость услуги',
                placeholder: 'Сумма',
              },
              commentsForClient: {
                name: 'comments4client',
                type: 'TEXTAREA',
                label: 'Предложение или вопрос клиенту',
                placeholder: COMMENT_PLACEHOLDER,
              },
              paymentMethod: null,
            },
          }
        : null,
    bidForms:
      o.open && s.formShown
        ? [
            {
              type: 'LEADGEN',
              bidSlideData: {
                buttons: { submit },
                elements: [
                  { name: 'stavka', type: 'INPUT', required: o.priceRequired },
                  { name: 'comments4client', type: 'TEXTAREA', required: false },
                ],
                paymentInfo: { value: fee, currencySymbol: '₽' },
                paymentInfoLabel: 'К оплате:',
              },
            },
          ]
        : [],
  }
}

// A page that asks before it is left; the browser asks only after the user has clicked in the page.
const LEAVE_ASK =
  '<script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = "" })</script>'

export async function startProfiSite(o: { port?: number } = {}): Promise<ProfiSite> {
  const sessions = new Set<string>()
  const orders: SiteOrder[] = []
  const chats = new Map<string, SiteMessage[]>()
  const sockets = new Set<Socket>()
  let banned = false
  let isOffline = false
  let hang = false
  let askLeave = false
  let drops = 0
  let rtpMuted = false
  let namesOnly = false
  let layout: Layout = NORMAL_LAYOUT
  const code = String(100000 + Math.floor(Math.random() * 899999))
  const state = {
    balance: 5000,
    openerClicks: 0,
    bidPosts: 0,
    feedRequests: 0,
    boardPageSize: 0,
    boardLayout: 'window' as BoardLayout,
  }
  const bids: SiteBid[] = []
  const freshBidSettings = (): BidSettings => ({
    mode: 'ok',
    payWay: 'wallet',
    behindOpener: true,
    openerCharges: 0,
    openerChargeShown: true,
    openerLeaves: false,
    openers: 1,
    opener: 'continue',
    openerAmount: null,
    openerText: 'Написать клиенту',
    klientDecoy: false,
    answer: true,
    hasBidField: true,
    showWallet: true,
    klientDelayMs: 0,
    formShown: true,
    hasBidLag: 0,
    postDelayMs: 0,
    formStays: false,
    barBalance: null,
    chatBid: true,
    chatBidDelayMs: 0,
  })
  /** Orders whose taken bid the order answer does not show yet, and for how many more answers. */
  const bidLag = new Map<string, number>()
  const bidSettings = freshBidSettings()

  function writeInChat(chatId: string, author: SiteAuthor, text: string): string {
    const id = `m${++seq}`
    // Our own messages are read: the list counts only what the other side wrote.
    const read = author === 'specialist'
    const m: SiteMessage = { id, side: author, text, ts: new Date().toISOString(), read }
    chats.set(chatId, [...(chats.get(chatId) ?? []), m])
    push(
      namesOnly
        ? { type: 'chat.touched', chatId, messageId: id }
        : { type: 'message.new', chatId, message: m },
    )
    return id
  }
  const sessOf = (req: IncomingMessage) => /sess=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
  const html = (res: ServerResponse, body: string) =>
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(
        (bidSettings.showWallet ? body : body.replace(/<span class="balance"[\s\S]*?<\/span>/, ''))
          .replaceAll('__BALANCE__', String(bidSettings.barBalance ?? state.balance))
          .replaceAll('__PRESENCE__', 'on') +
          (hang ? '<img src="/hang" alt="">' : '') +
          (askLeave ? LEAVE_ASK : ''),
      )
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
    // Never answered: the page that asked for it never fires «load».
    if (new URL(req.url ?? '/', 'http://x').pathname === '/hang') return
    if (drops > 0 && req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
      drops--
      return req.socket.destroy()
    }
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
    if (p === '/api/feed') {
      state.feedRequests++
      const open = orders.filter((x) => x.open)
      const size = state.boardPageSize
      if (size <= 0) return json(res, { [layout.feedKey]: open, totalCount: open.length })
      // Paged like the live board: a page and the cursor of the next one (here the index of its first order).
      const from = Number(url.searchParams.get('cursor') ?? 0) || 0
      const next = from + size
      return json(res, {
        [layout.feedKey]: open.slice(from, next),
        nextCursor: next < open.length ? String(next) : null,
        totalCount: open.length,
      })
    }
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
    if (p.startsWith('/api/chat/')) {
      const messages = chats.get(p.slice('/api/chat/'.length)) ?? []
      json(res, { messages })
      // As the live site: a chat its page showed is read.
      for (const m of messages) m.read = true
      return
    }
    if (p === '/graphql' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { variables?: { id?: string } }
      const found = orders.find((x) => x.id === body.variables?.id)
      if (!bidSettings.answer || !found) return json(res, { data: { orders: [] } })
      const lag = bidLag.get(found.id) ?? 0
      if (lag > 0) bidLag.set(found.id, lag - 1)
      const shown = lag > 0 ? { ...found, hasBid: false } : found
      return json(res, {
        data: { orders: [{ _id: found.id, boOrderScreen: orderScreen(shown, bidSettings) }] },
      })
    }
    // The backoffice API of the live site: every method at one address, the method named in the request.
    if (p === '/backoffice/api/' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        method?: string
        orderId?: string
      }
      const found = orders.find((x) => x.id === body.orderId)
      // The widget's question about another client is answered at once.
      const k = body.orderId === 'decoy' ? DECOY : found?.klient
      if (body.method !== 'getKlientInfo' || !k) return json(res, { error: 'not found' }, 404)
      if (body.orderId !== 'decoy' && bidSettings.klientDelayMs > 0)
        await new Promise((r) => setTimeout(r, bidSettings.klientDelayMs))
      return json(res, {
        data: {
          name: k.name,
          title: k.title,
          labels: k.verified ? [{ text: 'Номер подтверждён' }] : [],
          reviews: {
            count: { positive: k.positive, negative: k.negative },
            list: [{ tags: k.tags }],
          },
          ...(k.summaries && { summaries: k.summaries }),
        },
      })
    }
    if (p === '/api/bid' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}') as Partial<SiteBid>
      const found = orders.find((x) => x.id === b.orderId)
      const price = String(b.price ?? '')
      const text = String(b.text ?? '')
      state.bidPosts++
      if (bidSettings.postDelayMs > 0)
        await new Promise((r) => setTimeout(r, bidSettings.postDelayMs))
      if (!found?.open || found.hasBid || bidSettings.mode === 'silent')
        return json(res, { ok: false })
      if (found.priceRequired && !price) return json(res, { ok: false, error: 'Укажите стоимость' })
      if (text.length > 500 || state.balance < found.price) return json(res, { ok: false })
      if (bidSettings.mode === 'lost') return json(res, { ok: true })
      const priceTo = String(b.priceTo ?? '')
      bids.push({ orderId: found.id, price, text, ...(priceTo && { priceTo }) })
      state.balance -= found.price
      found.hasBid = true
      if (bidSettings.hasBidLag > 0) bidLag.set(found.id, bidSettings.hasBidLag)
      if (bidSettings.chatBid) {
        const show = () => {
          writeInChat(found.id, 'specialist', text)
          writeInChat(found.id, 'specialist', `Стоимость от ${price} до ${priceTo} руб. усл.`)
        }
        if (bidSettings.chatBidDelayMs > 0) setTimeout(show, bidSettings.chatBidDelayMs)
        else show()
      }
      return json(res, { ok: true })
    }
    if (p === '/api/bid/open') {
      state.openerClicks++
      state.balance -= bidSettings.openerCharges
      return json(res, { ok: true })
    }
    // A payment page of some other service: no top bar, no wallet.
    if (p === '/backoffice/pay.php')
      return res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html><h1>Оплата</h1>')
    if (p === '/backoffice/a.php') return html(res, feedPage(rtp.url, layout, state.boardLayout))
    if (p === '/backoffice/n.php')
      return html(res, orderPage(url.searchParams.get('o') ?? '', bidSettings))
    if (p === '/backoffice/widget.html') return html(res, widgetPage())
    if (p === '/chats') return html(res, chatsPage())
    // Like the real messenger page: it polls the site all the time, so the network never goes quiet.
    if (p === '/api/ping') return json(res, { ok: true })
    if (p === '/backoffice/busy.php')
      return html(
        res,
        `<!doctype html><a href="/chats/c-busy">c-busy</a><script>setInterval(() => fetch('/api/ping'), 200)</script>`,
      )
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
    get openerClicks() {
      return state.openerClicks
    },
    get bidPosts() {
      return state.bidPosts
    },
    get feedRequests() {
      return state.feedRequests
    },
    get boardPageSize() {
      return state.boardPageSize
    },
    set boardPageSize(n: number) {
      state.boardPageSize = n
    },
    get boardLayout() {
      return state.boardLayout
    },
    set boardLayout(l: BoardLayout) {
      state.boardLayout = l
    },
    bids,
    bidSettings,
    setBalance(rub) {
      state.balance = rub
    },
    resetBids() {
      bids.length = 0
      state.balance = 5000
      state.openerClicks = 0
      state.bidPosts = 0
      state.feedRequests = 0
      state.boardPageSize = 0
      state.boardLayout = 'window'
      Object.assign(bidSettings, freshBidSettings())
      bidLag.clear()
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
        hasBid: false,
        priceRequired: true,
        klient: {
          name: partial.clientName ?? 'Ирина',
          title: 'На Профи.ру с 7 сентября 2020',
          verified: true,
          positive: 2,
          negative: 0,
          tags: [],
        },
        ...partial,
      }
      orders.unshift(order)
      push({ type: 'order.new', order })
      return id
    },
    addMessage: writeInChat,
    logout() {
      sessions.clear()
      for (const c of clients) c.close()
    },
    ban() {
      banned = true
    },
    hangLoad(on) {
      hang = on
    },
    askBeforeLeave(on) {
      askLeave = on
    },
    dropNext(n) {
      drops = n
    },
    offline(on) {
      isOffline = on
      if (on) {
        for (const s of sockets) s.destroy()
        for (const c of clients) c.terminate()
      }
    },
    streamNamesOnly(on) {
      namesOnly = on
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
