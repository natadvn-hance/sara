import { type AuthorBasis, type ChatAuthor, type MessageSide, newEventId } from '@sara/shared'
import type { Db } from '../../src/db/client'
import { account, chatMessage, lead } from '../../src/db/schema'
import { ensureConversation, getConversation } from '../../src/conversation/store'
import type { ConversationRow } from '../../src/conversation/types'

export const ACC = 'hance-marketing'

export type SeedMessage = {
  id: string
  side: MessageSide
  text: string
  at: string
  author?: ChatAuthor
  basis?: AuthorBasis
  read?: boolean
}

const AUTHOR: Record<MessageSide, ChatAuthor> = {
  client: 'client',
  specialist: 'unknown',
  system: 'system',
  unknown: 'unknown',
}

/** The account, an order of an invented client, its conversation and the messages of the chat as the core stores them. */
export async function seedChat(
  db: Db,
  chatId: string,
  messages: SeedMessage[],
  o: { clientName?: string | null } = {},
): Promise<ConversationRow> {
  await db
    .insert(account)
    .values({ id: ACC, title: 'Hance', egressIp: '127.0.0.1' })
    .onConflictDoNothing()
  if (o.clientName !== null)
    await db
      .insert(lead)
      .values({
        id: chatId,
        accountId: ACC,
        title: 'Сайт для клиники',
        category: 'Сайты',
        city: 'Краснодар',
        text: 'Нужен сайт для стоматологической клиники',
        clientName: o.clientName ?? 'Анна',
        bidPriceRub: 1000,
        seenAt: new Date().toISOString(),
        correlationId: newEventId(),
      })
      .onConflictDoNothing()
  const conv = await ensureConversation(db, { accountId: ACC, chatId, orderId: chatId })
  await addMessages(db, conv.id, chatId, messages)
  const fresh = await getConversation(db, conv.id)
  if (!fresh) throw new Error('conversation vanished')
  return fresh
}

export async function addMessages(
  db: Db,
  conversationId: string,
  chatId: string,
  messages: SeedMessage[],
): Promise<void> {
  for (const m of messages)
    await db
      .insert(chatMessage)
      .values({
        id: newEventId(),
        accountId: ACC,
        chatId,
        orderId: chatId,
        platformMessageId: m.id,
        side: m.side,
        author: m.author ?? AUTHOR[m.side],
        authorBasis: m.basis ?? (m.side === 'specialist' ? 'v1_or_boris' : 'side'),
        text: m.text,
        sentAt: m.at,
        read: m.read ?? false,
        source: 'node',
        conversationId,
        heardAt: m.at,
      })
      .onConflictDoNothing()
}
