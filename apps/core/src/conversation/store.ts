import { newEventId } from '@sara/shared'
import { and, eq, isNull } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { chatMessage, conversation, deal } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { ConversationRow, StoredMessage } from './types'

export function rowOf(r: typeof conversation.$inferSelect): ConversationRow {
  return {
    id: r.id,
    accountId: r.accountId,
    chatId: r.chatId,
    orderId: r.orderId,
    dealId: r.dealId,
    origin: r.origin as ConversationRow['origin'],
    owner: r.owner as ConversationRow['owner'],
    ownerReason: r.ownerReason as ConversationRow['ownerReason'],
    borisNote: r.borisNote,
    closedAt: r.closedAt,
    handledThrough: r.handledThrough,
    lastClientHeardAt: r.lastClientHeardAt,
    typingAt: r.typingAt,
    unclearCount: r.unclearCount,
  }
}

export async function getConversation(db: DbOrTx, id: string): Promise<ConversationRow | null> {
  const [r] = await db.select().from(conversation).where(eq(conversation.id, id))
  return r ? rowOf(r) : null
}

export async function updateConversation(
  db: DbOrTx,
  id: string,
  patch: Partial<Omit<typeof conversation.$inferInsert, 'id' | 'accountId' | 'chatId'>>,
): Promise<ConversationRow> {
  const [r] = await db
    .update(conversation)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(conversation.id, id))
    .returning()
  if (!r) throw new Error(`conversation ${id} not found`)
  return rowOf(r)
}

/**
 * The conversation of an account's chat, made on the first message (ADR-024). The chat of a bid the new Sara made
 * links its deal (the chat's number is the order's); a chat begun by old Sara's bid has none.
 */
export async function ensureConversation(
  db: DbOrTx,
  i: { accountId: string; chatId: string; orderId: string | null },
): Promise<ConversationRow> {
  const orderId = i.orderId ?? null
  const [d] = orderId
    ? await db.select({ id: deal.id }).from(deal).where(eq(deal.leadId, orderId))
    : []
  const made = await db
    .insert(conversation)
    .values({
      id: newEventId(),
      accountId: i.accountId,
      chatId: i.chatId,
      orderId,
      dealId: d?.id ?? null,
      origin: d ? 'sara' : 'v1',
    })
    .onConflictDoNothing()
    .returning({ id: conversation.id })
  // The chat's history exported before the conversation existed joins it; old Sara's copies with made-up times
  // stay out, so a turn never reads them as the latest words (M4 design 5.1).
  if (made[0])
    await db
      .update(chatMessage)
      .set({ conversationId: made[0].id })
      .where(
        and(
          eq(chatMessage.accountId, i.accountId),
          eq(chatMessage.chatId, i.chatId),
          eq(chatMessage.source, 'node'),
          isNull(chatMessage.conversationId),
        ),
      )
  const [r] = await db
    .select()
    .from(conversation)
    .where(and(eq(conversation.accountId, i.accountId), eq(conversation.chatId, i.chatId)))
  if (!r) throw new Error(`conversation of chat ${i.chatId} was not made`)
  // An event without the order number came first: the order and its deal are filled in when they are known.
  if (r.orderId === null && orderId !== null)
    return updateConversation(db, r.id, {
      orderId,
      dealId: d?.id ?? null,
      origin: d ? 'sara' : r.origin,
    })
  return rowOf(r)
}

/**
 * FR-CONV-10: after the switch from old Sara a message from our side that is not the new Sara's own is Boris's,
 * and the client becomes his. In shadow old Sara may have written it, so nothing changes (ADR-024).
 */
export async function applyOwnerRule(
  db: DbOrTx,
  conv: ConversationRow,
  added: Pick<StoredMessage, 'side' | 'author' | 'authorBasis'>[],
  o: { v1Writes: boolean },
): Promise<ConversationRow> {
  if (o.v1Writes) return conv
  // Only his own message from the page: a text he dictated through the new Sara leaves the owner as it was.
  const boris = added.some(
    (m) => m.side === 'specialist' && m.author === 'boris' && m.authorBasis === 'after_cutover',
  )
  if (!boris || conv.owner === 'boris') return conv
  const after = await updateConversation(db, conv.id, { owner: 'boris', ownerReason: 'wrote' })
  await appendEvent(db, {
    type: 'conv.boris_wrote',
    v: 1,
    entity: { kind: 'conversation', id: conv.id },
    account_id: conv.accountId,
    actor: 'boris',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: conv.id,
    reason: 'Борис написал клиенту сам',
    payload: { chat_id: conv.chatId },
  })
  return after
}
