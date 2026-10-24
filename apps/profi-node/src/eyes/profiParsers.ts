import type { MessageAuthor, ProfiOrder } from '@sara/shared'
import type { Page } from 'playwright'
import type { MessageSignal, OrderSignal, ParseResult, Parsers, Signal } from './parsers'

// Real Profi.ru pages, read the way old Sara read them (checked live September-October 2026):
// src/ingestion/feedPoller.js, src/watcher/messageDom.js, src/negotiator/openChat.js of the old folder.
// The orders board also comes as a GraphQL answer (boSearchBoardItems, recorded live 24.10.2026).
// The event stream is recognized after calibration; until then it counts as unknown.

const ORDER_LINK = 'a[href*="n.php?o="]'
const MESSAGE = '[data-message-content-id]'
// CSS-module class names: stable within one build of Profi.ru, change on its redeploys.
const SIDE: Record<string, MessageAuthor> = {
  cw_iCsdtF: 'specialist',
  'cw_cO7-r-': 'client',
  cw_GK6qZJ: 'system',
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
    needsPage: true,
    order: {
      order_id: it.id,
      title,
      category: title,
      city,
      text: it.description ?? '',
      client_name: it.clientInfo?.name ?? '',
      budget_text: budget,
      // The fee for a bid is shown only on the order page.
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

export function fromSiteAnswer(url: string, body: unknown): ParseResult {
  if (/\/backoffice\/api\//.test(url)) return fromProfileAnswer(body)
  const board = (body as { data?: { boSearchBoardItems?: { items?: unknown } } } | null)?.data
    ?.boSearchBoardItems
  if (!/\/graphql/.test(url) || !board || !Array.isArray(board.items))
    return { recognized: false, signals: [] }
  const now = new Date().toISOString()
  const signals = (board.items as BoardItem[])
    .map((it) => boardOrder(it ?? {}, now))
    .filter((x): x is OrderSignal => x !== null)
  return { recognized: true, what: 'feed', signals }
}

export const profiParsers: Parsers = {
  paths: {
    feed: '/backoffice/n.php',
    chats: '/backoffice/r.php',
    order: (id) => `/backoffice/n.php?o=${encodeURIComponent(id)}`,
    chat: (id) => `/backoffice/r.php?id=${encodeURIComponent(id)}`,
  },
  banMarkers: ['Профиль заблокирован', 'Ваш профиль заблокирован'],
  fromRtp: () => ({ recognized: false, signals: [] }),
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
    // The wallet sits in the top bar as its own short label, like «23 ₽».
    const rub = await page
      .evaluate(() => {
        for (const el of document.querySelectorAll('nav *, header *')) {
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

  async fromChatDom(page, chatId) {
    await page.waitForSelector(MESSAGE, { timeout: 15000 }).catch(() => {})
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
    const now = new Date().toISOString()
    const signals: MessageSignal[] = raw
      .filter((r) => r.id)
      .map((r) => {
        const cls = String(r.cls)
          .split(/\s+/)
          .find((c) => SIDE[c])
        return {
          t: 'message',
          message: {
            platform_message_id: r.id,
            chat_id: chatId,
            order_id: chatId,
            // An unknown class is never guessed (FR-CONV-2).
            author: cls ? (SIDE[cls] ?? 'unknown') : 'unknown',
            // The page shows only HH:MM badges; the moment the eyes saw it stands in until calibration.
            sent_at: now,
            text: r.text,
            read: true,
          },
        }
      })
    return { recognized: raw.length > 0, what: 'chat', signals }
  },
}

/** The set the live service uses. */
export const activeParsers: Parsers = profiParsers
