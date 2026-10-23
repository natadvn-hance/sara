import type { ChatMessage, MessageAuthor, ProfiOrder } from '@sara/shared'
import type { Page } from 'playwright'

export type OrderSignal = { t: 'order'; order: ProfiOrder; published_at: string | null }
export type MessageSignal = { t: 'message'; message: ChatMessage & { order_id: string | null } }
export type Signal =
  | OrderSignal
  | MessageSignal
  | { t: 'balance'; rub: number }
  | { t: 'presence'; on: boolean }

/** recognized: the source had the shape we know (even if empty). False is how a layout change shows. */
export type ParseResult = {
  recognized: boolean
  what?: 'feed' | 'chat' | 'order' | 'stream'
  signals: Signal[]
}

export type Parsers = {
  paths: { feed: string; chats: string; chat(id: string): string }
  banMarkers: string[]
  fromRtp(body: unknown): ParseResult
  fromResponse(url: string, body: unknown): ParseResult
  fromHeaderDom(page: Page): Promise<Signal[]>
  fromChatsDom(page: Page): Promise<{ chatId: string; unread: number; lastAt: string | null }[]>
  fromChatDom(page: Page, chatId: string): Promise<ParseResult>
}

const NONE: ParseResult = { recognized: false, signals: [] }

type StandInOrder = {
  id: string
  subject: string
  category: string
  city: string
  description: string
  clientName: string
  budget: string | null
  price: number
  publishedAt: string
}
type StandInMessage = { id: string; side: string; text: string; ts: string; read: boolean }

const AUTHORS: Record<string, MessageAuthor> = {
  client: 'client',
  specialist: 'specialist',
  system: 'system',
}

function order(o: StandInOrder): OrderSignal {
  return {
    t: 'order',
    order: {
      order_id: o.id,
      title: o.subject,
      category: o.category,
      city: o.city,
      text: o.description,
      client_name: o.clientName,
      budget_text: o.budget,
      bid_price_rub: o.price,
      seen_at: new Date().toISOString(),
    },
    published_at: o.publishedAt,
  }
}

function message(chatId: string, m: StandInMessage): MessageSignal {
  return {
    t: 'message',
    message: {
      platform_message_id: m.id,
      chat_id: chatId,
      order_id: null,
      // A side we do not know is never guessed (FR-CONV-2).
      author: AUTHORS[m.side] ?? 'unknown',
      sent_at: m.ts,
      text: m.text,
      read: m.read,
    },
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Formats of the stand-in site (tests/fakes/profiSite). Replaced by the real ones after calibration (Task 16). */
export const standInParsers: Parsers = {
  paths: { feed: '/backoffice/a.php', chats: '/chats', chat: (id) => `/chats/${id}` },
  banMarkers: ['Ваш профиль заблокирован'],
  fromRtp(body) {
    if (!isObj(body)) return NONE
    if (body.type === 'order.new' && isObj(body.order)) {
      return { recognized: true, what: 'stream', signals: [order(body.order as StandInOrder)] }
    }
    if (body.type === 'message.new' && isObj(body.message) && typeof body.chatId === 'string') {
      return {
        recognized: true,
        what: 'stream',
        signals: [message(body.chatId, body.message as StandInMessage)],
      }
    }
    return NONE
  },
  fromResponse(url, body) {
    const path = new URL(url).pathname
    if (path === '/api/feed') {
      if (!isObj(body) || !Array.isArray(body.items)) return NONE
      return { recognized: true, what: 'feed', signals: (body.items as StandInOrder[]).map(order) }
    }
    if (path.startsWith('/api/order/') && isObj(body) && typeof body.id === 'string') {
      return { recognized: true, what: 'order', signals: [order(body as unknown as StandInOrder)] }
    }
    const chat = /^\/api\/chat\/(.+)$/.exec(path)
    if (chat?.[1] && isObj(body) && Array.isArray(body.messages)) {
      const id = decodeURIComponent(chat[1])
      return {
        recognized: true,
        what: 'chat',
        signals: (body.messages as StandInMessage[]).map((m) => message(id, m)),
      }
    }
    return NONE
  },
  async fromHeaderDom(page) {
    const out: Signal[] = []
    const rub = await page
      .locator('.balance')
      .getAttribute('data-rub', { timeout: 1000 })
      .catch(() => null)
    if (rub && /^\d+$/.test(rub)) out.push({ t: 'balance', rub: Number(rub) })
    const presence = await page
      .locator('.presence')
      .getAttribute('class', { timeout: 1000 })
      .catch(() => null)
    if (presence) out.push({ t: 'presence', on: presence.split(/\s+/).includes('on') })
    return out
  },
  async fromChatsDom(page) {
    return page
      .locator('.chat-link')
      .evaluateAll((links) =>
        links.map((a) => ({
          chatId: a.getAttribute('data-chat-id') ?? '',
          unread: Number(a.parentElement?.querySelector('.unread')?.textContent ?? '0'),
          lastAt: a.getAttribute('data-last') || null,
        })),
      )
      .catch(() => [])
  },
  async fromChatDom(page, chatId) {
    // Bubble classes from v1 (src/watcher/messageDom.js): an unknown class is 'unknown', not a guess.
    const raw = await page
      .locator('[data-message-content-id]')
      .evaluateAll((els) =>
        els.map((el) => ({
          id: el.getAttribute('data-message-content-id') ?? '',
          cls: el.className,
          ts: el.getAttribute('data-sent-at') ?? '',
          text: (el.querySelector('.cw_xeDn2R .cw_BFgZYK') as HTMLElement | null)?.innerText ?? '',
        })),
      )
      .catch(() => [])
    const side = (cls: string) =>
      cls.includes('cw_iCsdtF')
        ? 'specialist'
        : cls.includes('cw_cO7-r-')
          ? 'client'
          : cls.includes('cw_GK6qZJ')
            ? 'system'
            : 'x'
    return {
      recognized: raw.length > 0,
      what: 'chat',
      signals: raw.map((r) =>
        message(chatId, { id: r.id, side: side(r.cls), text: r.text, ts: r.ts, read: true }),
      ),
    }
  },
}

/** The active set. Task 16 switches this to the formats recorded on the live site. */
export const activeParsers: Parsers = standInParsers
