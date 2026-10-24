import { and, eq, max } from 'drizzle-orm'
import { chatMessage } from '../db/schema'
import { type ConversationEventDeps, onChatNews } from './events'
import { ensureConversation } from './store'

/** Chats quiet longer than this are not reread by the check (old Sara's line, KNOWN_CHAT_MS). */
const RECENT_MS = 3 * 24 * 3600_000

/**
 * The insurance of FR-CONV-1: every 10 minutes the node's chat list is compared with what the core stored, and a
 * chat with a newer last message is read as if its event had come. Returns how many chats were read.
 */
export async function reconcileChats(
  d: ConversationEventDeps,
  accountIds: string[],
  now: Date = new Date(),
): Promise<number> {
  let read = 0
  for (const accountId of accountIds) {
    const { chats } = await d.profi.listChats(accountId)
    for (const c of chats) {
      if (!c.last_message_at || now.getTime() - new Date(c.last_message_at).getTime() > RECENT_MS)
        continue
      const [ours] = await d.db
        .select({ last: max(chatMessage.sentAt) })
        .from(chatMessage)
        .where(and(eq(chatMessage.accountId, accountId), eq(chatMessage.chatId, c.chat_id)))
      if (ours?.last && new Date(ours.last).getTime() >= new Date(c.last_message_at).getTime())
        continue
      const conv = await ensureConversation(d.db, {
        accountId,
        chatId: c.chat_id,
        orderId: c.order_id,
      })
      await onChatNews(d, conv, now, { clientHeard: true })
      read++
    }
  }
  return read
}

/** Runs the check every `everyMs`; a failed round is logged and the next one tries again. */
export function startReconcile(
  d: ConversationEventDeps,
  accountIds: string[],
  everyMs = 600_000,
): { stop(): void } {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void reconcileChats(d, accountIds)
      .catch((e) => console.error('chat check failed', e instanceof Error ? e.message : e))
      .finally(() => {
        running = false
      })
  }, everyMs)
  return { stop: () => clearInterval(timer) }
}
