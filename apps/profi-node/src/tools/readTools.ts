import {
  type ChatMessage,
  type ChatSummary,
  type FeedOrder,
  type GetOrderOutput,
  MessageAuthor,
  type ProfiOrder,
} from '@sara/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { NodeDb } from '../db/client'
import { rawMessage, rawOrder } from '../db/schema'
import { ProfiToolError, type ProfiToolsImpl } from '../mcp/server'
import { shipperHealth } from '../ship/shipper'
import { requireAlive, type SessionState } from '../watch/sessionWatch'

export type AccountRuntime = {
  watch: { state(): SessionState }
  eyes: { balance(): number | null; presence(): boolean; lastRecognizedAt(): number }
  egressIp(): string | null
  egressOk(): boolean
  silenceMs: number
}

type StoredOrder = ProfiOrder & { published_at?: string | null }

/** C2 for the live service: everything is answered from what the eyes already saw (schema node). */
export function createReadTools(o: {
  db: NodeDb
  accounts: Map<string, AccountRuntime>
}): ProfiToolsImpl {
  const runtime = (id: string) => {
    const r = o.accounts.get(id)
    if (!r) throw new ProfiToolError('NOT_FOUND', `account ${id} is not served here`)
    return r
  }
  const alive = (id: string) => {
    requireAlive(runtime(id).watch)
  }

  return {
    async sessionHealth({ account_id }) {
      const r = runtime(account_id)
      const { queued, dead } = await shipperHealth(o.db)
      return {
        alive: r.watch.state() === 'alive',
        balance_rub: r.eyes.balance(),
        presence: r.eyes.presence(),
        egress_ip: r.egressIp(),
        queued_events: queued,
        dead_events: dead,
        eyes_seeing: Date.now() - r.eyes.lastRecognizedAt() < r.silenceMs,
        egress_ok: r.egressOk(),
      }
    },

    async listFeed({ account_id }) {
      alive(account_id)
      const rows = await o.db
        .select()
        .from(rawOrder)
        .where(eq(rawOrder.accountId, account_id))
        .orderBy(desc(rawOrder.seenAt))
        .limit(200)
      const orders: FeedOrder[] = rows.map((r) => {
        const b = r.body as StoredOrder
        return {
          order_id: r.orderId,
          title: b.title,
          city: b.city,
          budget_text: b.budget_text,
          bid_price_rub: b.bid_price_rub,
          published_at: b.published_at ?? null,
        }
      })
      return { orders }
    },

    async getOrder({ account_id, order_id }): Promise<GetOrderOutput> {
      alive(account_id)
      const [r] = await o.db
        .select()
        .from(rawOrder)
        .where(and(eq(rawOrder.accountId, account_id), eq(rawOrder.orderId, order_id)))
      if (!r) throw new ProfiToolError('NOT_FOUND', `order ${order_id} was not seen`)
      const { published_at, ...order } = r.body as StoredOrder
      // Whether the order closed is not tracked in M1 (order_changed comes later).
      return { ...order, open: true, published_at: published_at ?? null }
    },

    async listChats({ account_id }) {
      alive(account_id)
      const rows = await o.db.select().from(rawMessage).where(eq(rawMessage.accountId, account_id))
      const chats = new Map<string, ChatSummary>()
      for (const m of rows) {
        const c = chats.get(m.chatId) ?? {
          chat_id: m.chatId,
          order_id: m.orderId,
          last_message_at: null,
          unread: 0,
        }
        if (!c.last_message_at || m.sentAt > c.last_message_at)
          c.last_message_at = new Date(m.sentAt).toISOString()
        if (!m.read && m.author === 'client') c.unread++
        c.order_id ??= m.orderId
        chats.set(m.chatId, c)
      }
      return { chats: [...chats.values()] }
    },

    async readChat({ account_id, chat_id }) {
      alive(account_id)
      const rows = await o.db
        .select()
        .from(rawMessage)
        .where(and(eq(rawMessage.accountId, account_id), eq(rawMessage.chatId, chat_id)))
        .orderBy(asc(rawMessage.sentAt))
      const messages: ChatMessage[] = rows.map((m) => ({
        platform_message_id: m.platformMessageId,
        chat_id: m.chatId,
        author: MessageAuthor.safeParse(m.author).data ?? 'unknown',
        sent_at: new Date(m.sentAt).toISOString(),
        text: m.text,
        read: m.read,
      }))
      return { messages }
    },

    async submitBid() {
      throw new ProfiToolError('INTERNAL', 'Откликов в M1 нет: служба только читает')
    },
  }
}
