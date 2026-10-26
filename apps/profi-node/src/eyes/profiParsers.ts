import type { MessageAuthor, ProfiOrder } from '@sara/shared'
import type { Page } from 'playwright'
import { clientInfoFromAnswer } from './clientInfo'
import type { MessageSignal, OrderSignal, ParseResult, Parsers, Signal } from './parsers'

// Real Profi.ru pages, read the way old Sara read them (checked live September-October 2026):
// src/ingestion/feedPoller.js, src/watcher/messageDom.js, src/negotiator/openChat.js of the old folder.
// The orders board also comes as a GraphQL answer (boSearchBoardItems, recorded live 24.10.2026).
// The event stream (SockJS frames from online.profi.ru, recorded live 24.10.2026) names chats with news.

const ORDER_LINK = 'a[href*="n.php?o="]'
const MESSAGE = '[data-message-content-id]'
// CSS-module class names: stable within one build of Profi.ru, change on its redeploys.
const SIDE: Record<string, MessageAuthor> = {
  cw_iCsdtF: 'specialist',
  'cw_cO7-r-': 'client',
  cw_GK6qZJ: 'system',
}

/** A bubble's author by its classes, on the page or in a kept chat record; an unknown class is never guessed (FR-CONV-2). */
export function authorFromClasses(classes: string[]): MessageAuthor {
  const side = classes.find((c) => SIDE[c])
  return side ? (SIDE[side] ?? 'unknown') : 'unknown'
}

/** The order page's text: anchored on its fixed section headers (old Sara, extractOrderFieldsFromPage). */
export function orderFromPageText(
  text: string,
  orderId: string,
): (ProfiOrder & { published_at: null }) | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const support = lines.indexOf('Поддержка')
  const desc = lines.indexOf('Описание')
  // An expired or hidden order still renders the menu but never the order sections.
  if (desc < 0) return null
  const title = support >= 0 ? (lines[support + 1] ?? '') : ''
  const budget =
    support >= 0 && desc > support
      ? (lines.slice(support + 2, desc).find((l) => /₽/.test(l)) ?? null)
      : null
  const remote = lines.indexOf('Дистанционно')
  const when = lines.indexOf('Когда')
  const details = lines.indexOf('Детали заказа')
  const end =
    [remote, when, details].filter((i) => i > desc).sort((a, b) => a - b)[0] ?? lines.length
  const body = lines.slice(desc + 1, end).join('\n')
  const city = remote >= 0 ? (lines[remote + 1] ?? '') : ''
  let client = ''
  for (let i = Math.max(details, 0); i < lines.length - 1; i++) {
    if (/^[А-ЯЁA-Z]$/.test(lines[i] ?? '')) {
      client = lines[i + 1] ?? ''
      break
    }
  }
  const fee = /Отклик\s*•\s*(\d+)\s*₽/.exec(text)
  return {
    order_id: orderId,
    title,
    category: title,
    city,
    text: body,
    client_name: client,
    budget_text: budget,
    bid_price_rub: fee ? Number(fee[1]) : 0,
    seen_at: new Date().toISOString(),
    published_at: null,
  }
}

type Place = { prefix?: string | null } | null | undefined
type BoardItem = {
  id?: unknown
  type?: unknown
  title?: string | null
  description?: string | null
  geo?: { remote?: Place; orderLocation?: Place; clientMayCome?: Place } | null
  price?: { value?: string | null; prefix?: string | null; suffix?: string | null } | null
  clientInfo?: { name?: string | null } | null
  lastUpdateDate?: number | null
  /** A CAROUSEL item: older orders among the cards, without their own type or client name. */
  snippets?: BoardItem[] | null
}

/** One order card of the GraphQL board; other item kinds (banners and the like) are skipped. */
function boardOrder(it: BoardItem, seenAt: string): OrderSignal | null {
  if (it.type !== 'SNIPPET' || typeof it.id !== 'string' || !/^\d+$/.test(it.id)) return null
  const g = it.geo
  const city = g?.remote?.prefix || g?.orderLocation?.prefix || g?.clientMayCome?.prefix || ''
  const p = it.price
  const budget = p?.value ? [p.prefix, p.value, p.suffix].filter(Boolean).join(' ') : null
  const title = it.title ?? ''
  return {
    t: 'order',
    order: {
      order_id: it.id,
      title,
      category: title,
      city,
      text: it.description ?? '',
      client_name: it.clientInfo?.name ?? '',
      budget_text: budget,
      // The fee for a bid is shown only on the order page, which get_order reads for the orders worth it: 0 is unknown.
      bid_price_rub: 0,
      seen_at: seenAt,
    },
    published_at:
      typeof it.lastUpdateDate === 'number'
        ? new Date(it.lastUpdateDate * 1000).toISOString()
        : null,
  }
}

/** The wallet: the profile answer of the backoffice API carries it as a plain number of rubles. */
function fromProfileAnswer(body: unknown): ParseResult {
  const data = (body as { data?: { balance?: unknown; currency?: unknown } } | null)?.data
  if (typeof data?.balance !== 'number' || data.currency !== '₽')
    return { recognized: false, signals: [] }
  return { recognized: true, signals: [{ t: 'balance', rub: Math.floor(data.balance) }] }
}

type OrderScreen = {
  _id?: unknown
  boOrderScreen?: {
    id?: unknown
    price?: { value?: unknown; baseValue?: unknown } | null
    hasBid?: unknown
  } | null
}

/**
 * The order page's GraphQL answer (orders[].boOrderScreen, recorded live 24.10.2026). Its price is what a bid
 * costs this account now: with a discount it is «1» while baseValue keeps the usual price.
 */
function fromOrderAnswer(orders: unknown[]): ParseResult {
  const signals: Signal[] = []
  for (const o of orders as (OrderScreen | null)[]) {
    const screen = o?.boOrderScreen
    const orderId = String(o?._id ?? screen?.id ?? '')
    const digits = String(screen?.price?.value ?? '').replace(/[^\d]/g, '')
    if (!/^\d+$/.test(orderId) || digits === '') continue
    const base = String(screen?.price?.baseValue ?? '').replace(/[^\d]/g, '')
    signals.push({
      t: 'order_fee',
      orderId,
      rub: Number(digits),
      baseRub: base === '' ? null : Number(base),
      hasBid: typeof screen?.hasBid === 'boolean' ? screen.hasBid : null,
    })
  }
  return { recognized: true, what: 'order', signals }
}

export function fromSiteAnswer(url: string, body: unknown): ParseResult {
  if (/\/backoffice\/api\//.test(url)) {
    const profile = fromProfileAnswer(body)
    // The client of an order page (getKlientInfo) is read by get_order itself; here it is only a known answer.
    return profile.recognized || !clientInfoFromAnswer(body)
      ? profile
      : { recognized: true, what: 'client', signals: [] }
  }
  const data = (
    body as {
      data?: { boSearchBoardItems?: { items?: unknown; nextCursor?: unknown }; orders?: unknown }
    } | null
  )?.data
  if (/\/graphql/.test(url) && Array.isArray(data?.orders)) return fromOrderAnswer(data.orders)
  const board = data?.boSearchBoardItems
  if (!/\/graphql/.test(url) || !board || !Array.isArray(board.items))
    return { recognized: false, signals: [] }
  const now = new Date().toISOString()
  // The carousel's orders are read like the other cards (Boris, 24.10.2026).
  const signals = (board.items as (BoardItem | null)[])
    .flatMap((it) =>
      it?.type === 'CAROUSEL' && Array.isArray(it.snippets)
        ? it.snippets.map((x) => ({ ...x, type: 'SNIPPET' }))
        : [it ?? {}],
    )
    .map((it) => boardOrder(it, now))
    .filter((x): x is OrderSignal => x !== null)
  // The board holds the first ~17 of its orders in an answer, by relevance, not by time: the next pages come by cursor.
  const more = typeof board.nextCursor === 'string' && board.nextCursor !== ''
  return { recognized: true, what: 'feed', signals, more }
}

const CHAT_NOTICE = new Set(['MSG_CHAT_ORDER_NOTIFY', 'MSG_MESSENGER_UNREAD_NOTIFY'])

/** One SockJS frame: «o» opens, «h» is a heartbeat, «a[...]» carries JSON strings, one per event. */
export function fromStreamFrame(body: unknown): ParseResult {
  const none: ParseResult = { recognized: false, signals: [] }
  if (body === 'o' || body === 'h') return { recognized: true, what: 'stream', signals: [] }
  if (typeof body !== 'string' || !body.startsWith('a[')) return none
  let items: unknown[]
  try {
    items = (JSON.parse(body.slice(1)) as unknown[]).map((x) =>
      typeof x === 'string' ? JSON.parse(x) : x,
    )
  } catch {
    return none
  }
  const signals: Signal[] = []
  for (const it of items as {
    type?: unknown
    messengerType?: unknown
    messengerExtId?: unknown
    messageId?: unknown
  }[]) {
    if (!CHAT_NOTICE.has(String(it?.type)) || it.messengerType !== 'ORDER') continue
    if (it.messengerExtId === undefined || it.messengerExtId === null) continue
    signals.push({
      t: 'chat_touched',
      // The order chat lives at r.php?id=<order number> (old Sara, checked live on six leads).
      chatId: String(it.messengerExtId),
      messageId: it.messageId === undefined || it.messageId === null ? null : String(it.messageId),
    })
  }
  return { recognized: true, what: 'stream', signals }
}

export const profiParsers: Parsers = {
  boardCards: ORDER_LINK,
  paths: {
    feed: '/backoffice/n.php',
    chats: '/backoffice/r.php',
    order: (id) => `/backoffice/n.php?o=${encodeURIComponent(id)}`,
    chat: (id) => `/backoffice/r.php?id=${encodeURIComponent(id)}`,
  },
  banMarkers: ['Профиль заблокирован', 'Ваш профиль заблокирован'],
  fromRtp: fromStreamFrame,
  fromResponse: fromSiteAnswer,

  async fromFeedDom(page) {
    // Cards render after load; an empty feed simply times out here.
    await page.waitForSelector(ORDER_LINK, { timeout: 15000 }).catch(() => {})
    const raw = await page
      .locator(ORDER_LINK)
      .evaluateAll((links) =>
        links.map((a) => ({
          href: a.getAttribute('href') ?? '',
          snippet: (a as HTMLElement).innerText,
        })),
      )
      .catch(() => [])
    const seen = new Set<string>()
    const refs = []
    for (const r of raw) {
      const id = /[?&]o=(\d+)/.exec(r.href)?.[1]
      if (!id || seen.has(id)) continue
      seen.add(id)
      refs.push({ orderId: id, snippet: r.snippet })
    }
    // The menu is there even when the feed is empty: that is how a known page looks.
    const menu = await page
      .locator('a[href*="/backoffice/"]')
      .count()
      .catch(() => 0)
    return { recognized: refs.length > 0 || menu > 0, refs }
  },

  async fromOrderDom(page, orderId) {
    // The price panel («Тариф») renders later than the rest of the order (old Sara, 6 live orders).
    await page.waitForSelector('text=Тариф', { timeout: 10000 }).catch(() => {})
    const text = await page
      .locator('body')
      .innerText({ timeout: 5000 })
      .catch(() => '')
    const order = orderFromPageText(text, orderId)
    if (!order) return { recognized: false, what: 'order', signals: [] }
    const { published_at, ...o } = order
    return { recognized: true, what: 'order', signals: [{ t: 'order', order: o, published_at }] }
  },

  async fromHeaderDom(page) {
    const out: Signal[] = []
    // The wallet sits in the top bar as its own short label, like «23 ₽»; its «Баланс» label (old Sara,
    // paymentPanel.js, checked live 25.09.2026) finds it wherever the bar is drawn.
    const rub = await page
      .evaluate(() => {
        for (const el of document.querySelectorAll(
          '[aria-label="Баланс"], [aria-label="Баланс"] *, nav *, header *',
        )) {
          const t = (el as HTMLElement).innerText?.trim() ?? ''
          if (el.children.length === 0 && /^\d[\d\s\u00a0]*₽$/.test(t))
            return Number(t.replace(/[^\d]/g, ''))
        }
        return null
      })
      .catch(() => null)
    if (rub !== null) out.push({ t: 'balance', rub })
    return out
  },

  async chatsUrl(page) {
    const href = await page
      .locator('a', { hasText: /^\s*Чаты\s*$/ })
      .first()
      .getAttribute('href', { timeout: 2000 })
      .catch(() => null)
    if (!href) return null
    // Kept as a path on the site, whatever form the menu uses.
    const u = new URL(href, 'https://profi.ru')
    return `${u.pathname}${u.search}`
  },

  async fromChatsDom(page) {
    const raw = await page
      .locator('a[href*="r.php?id="]')
      .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''))
      .catch(() => [] as string[])
    const ids = [
      ...new Set(raw.map((h) => /[?&]id=(\d+)/.exec(h)?.[1]).filter((x): x is string => !!x)),
    ]
    // Unread marks are not known yet: the newest chats are read, the list keeps the site's order.
    return ids.slice(0, 8).map((chatId) => ({ chatId, unread: 1, lastAt: null }))
  },

  async fromChatDom(page, chatId, o) {
    // 0 is no wait at all (a Playwright timeout of 0 would wait for ever).
    const wait = o?.waitMs ?? 15000
    if (wait > 0) await page.waitForSelector(MESSAGE, { timeout: wait }).catch(() => {})
    const raw = await page
      .locator(MESSAGE)
      .evaluateAll((els) =>
        els.map((el) => ({
          id: el.getAttribute('data-message-content-id') ?? '',
          cls: el.className,
          text: (el.querySelector('.cw_xeDn2R .cw_BFgZYK') as HTMLElement | null)?.innerText ?? '',
        })),
      )
      .catch(() => [])
    const now = Date.now()
    const signals: MessageSignal[] = raw
      .filter((r) => r.id)
      .map((r, i, all) => ({
        t: 'message',
        message: {
          platform_message_id: r.id,
          chat_id: chatId,
          order_id: chatId,
          author: authorFromClasses(String(r.cls).split(/\s+/)),
          // The page shows only HH:MM badges; the moment the eyes saw it stands in until calibration,
          // 1 ms apart in page order so one reading keeps its order, the last one at the moment itself.
          sent_at: new Date(now - (all.length - 1 - i)).toISOString(),
          text: r.text,
          read: true,
        },
      }))
    return { recognized: raw.length > 0, what: 'chat', signals }
  },
}

/** The set the live service uses. */
export const activeParsers: Parsers = profiParsers
