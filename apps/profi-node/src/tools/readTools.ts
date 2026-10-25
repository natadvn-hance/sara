import {
  type ChatMessage,
  type ChatSummary,
  type FeedOrder,
  type GetOrderOutput,
  MessageAuthor,
  type ProfiOrder,
} from '@sara/shared'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
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

/**
 * The order as the eyes stored it, never read from its page now (from_page false): whether it closed or was bid on
 * is known only from its page (src/bid/bidTools.ts).
 */
export async function storedOrder(
  db: NodeDb,
  accountId: string,
  orderId: string,
): Promise<GetOrderOutput> {
  const [r] = await db
    .select()
    .from(rawOrder)
    .where(and(eq(rawOrder.accountId, accountId), eq(rawOrder.orderId, orderId)))
  if (!r) throw new ProfiToolError('NOT_FOUND', `order ${orderId} was not seen`)
  const { published_at, has_bid, ...order } = r.body as StoredOrder & { has_bid?: boolean }
  return {
    ...order,
    open: true,
    published_at: published_at ?? null,
    has_bid: typeof has_bid === 'boolean' ? has_bid : null,
    from_page: false,
  }
}

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
      return storedOrder(o.db, account_id, order_id)
    },

    async listChats({ account_id }) {
      alive(account_id)
      // Aggregated in the database: the last time is compared as time, not as text.
      const rows = await o.db.execute<{
        chat_id: string
        order_id: string | null
        last_at: string | null
        unread: number
      }>(sql`
        select chat_id, max(order_id) as order_id, max(sent_at) as last_at,
          count(*) filter (where not read and author = 'client')::int as unread
        from node.raw_message where account_id = ${account_id} group by chat_id`)
      const chats: ChatSummary[] = rows.rows.map((r) => ({
        chat_id: r.chat_id,
        order_id: r.order_id,
        last_message_at: r.last_at === null ? null : new Date(r.last_at).toISOString(),
        unread: r.unread,
      }))
      return { chats }
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

    // M4 is shadow: nothing goes to a client until the switch from old Sara (ADR-024).
    async sendMessage() {
      throw new ProfiToolError(
        'INTERNAL',
        'Служба не пишет в чаты: отправка сообщений ещё не построена',
      )
    },
  }
}
