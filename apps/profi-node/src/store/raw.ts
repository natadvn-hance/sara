import { newEventId, type ProfiOrder } from '@sara/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { NodeDbOrTx } from '../db/client'
import { bidAttempt, messageAttempt, rawEvent, rawMessage, rawOrder } from '../db/schema'

export type RawKind = 'rtp' | 'response' | 'dom'

export async function saveRaw(
  db: NodeDbOrTx,
  r: { accountId: string; kind: RawKind; url?: string | null; body: unknown; receivedAt?: string },
): Promise<string> {
  const id = newEventId()
  await db.insert(rawEvent).values({
    id,
    accountId: r.accountId,
    kind: r.kind,
    url: r.url ?? null,
    body: r.body ?? null,
    receivedAt: r.receivedAt ?? new Date().toISOString(),
  })
  return id
}

/** True when this order was not seen on this account before. */
export async function upsertOrder(
  db: NodeDbOrTx,
  o: { accountId: string; order: ProfiOrder; body: unknown },
): Promise<boolean> {
  const rows = await db
    .insert(rawOrder)
    .values({
      orderId: o.order.order_id,
      accountId: o.accountId,
      seenAt: o.order.seen_at,
      body: o.body ?? o.order,
    })
    .onConflictDoNothing()
    .returning({ id: rawOrder.orderId })
  return rows.length > 0
}

/** The order page showed this account's bid: get_order answers so even when the tab may not move. */
export async function markOrderBid(db: NodeDbOrTx, accountId: string, orderId: string) {
  await db
    .update(rawOrder)
    .set({ body: sql`${rawOrder.body} || '{"has_bid": true}'::jsonb` })
    .where(and(eq(rawOrder.accountId, accountId), eq(rawOrder.orderId, orderId)))
}

export type BidAttempt = { dueRub: number; result: unknown }

export async function findBidAttempt(db: NodeDbOrTx, key: string): Promise<BidAttempt | null> {
  const [r] = await db
    .select({ dueRub: bidAttempt.dueRub, result: bidAttempt.result })
    .from(bidAttempt)
    .where(eq(bidAttempt.idempotencyKey, key))
  return r ?? null
}

/** Written before the send button is pressed: false when a press with this key was already written. */
export async function savePress(
  db: NodeDbOrTx,
  p: { key: string; accountId: string; orderId: string; dueRub: number },
): Promise<boolean> {
  const rows = await db
    .insert(bidAttempt)
    .values({
      idempotencyKey: p.key,
      accountId: p.accountId,
      orderId: p.orderId,
      dueRub: p.dueRub,
      pressedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .returning({ key: bidAttempt.idempotencyKey })
  return rows.length > 0
}

export async function saveBidResult(db: NodeDbOrTx, key: string, result: unknown): Promise<void> {
  await db.update(bidAttempt).set({ result }).where(eq(bidAttempt.idempotencyKey, key))
}

export type MessageAttempt = {
  accountId: string
  chatId: string
  expectLastMessageId: string | null
  result: unknown
}

export async function findMessageAttempt(
  db: NodeDbOrTx,
  key: string,
): Promise<MessageAttempt | null> {
  const [r] = await db
    .select({
      accountId: messageAttempt.accountId,
      chatId: messageAttempt.chatId,
      expectLastMessageId: messageAttempt.expectLastMessageId,
      result: messageAttempt.result,
    })
    .from(messageAttempt)
    .where(eq(messageAttempt.idempotencyKey, key))
  return r ?? null
}

/** Written before the send button is pressed: false when a press with this key was already written. */
export async function saveMessagePress(
  db: NodeDbOrTx,
  p: { key: string; accountId: string; chatId: string; expectLastMessageId: string | null },
): Promise<boolean> {
  const rows = await db
    .insert(messageAttempt)
    .values({
      idempotencyKey: p.key,
      accountId: p.accountId,
      chatId: p.chatId,
      expectLastMessageId: p.expectLastMessageId,
      pressedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .returning({ key: messageAttempt.idempotencyKey })
  return rows.length > 0
}

export async function saveMessageResult(
  db: NodeDbOrTx,
  key: string,
  result: unknown,
): Promise<void> {
  await db.update(messageAttempt).set({ result }).where(eq(messageAttempt.idempotencyKey, key))
}

export type StoredMessage = {
  platform_message_id: string
  chat_id: string
  order_id: string | null
  author: string
  sent_at: string
  text: string
  read: boolean
}

/** True when this platform message was not stored before. */
export async function upsertMessage(
  db: NodeDbOrTx,
  m: { accountId: string; message: StoredMessage; history?: boolean },
): Promise<boolean> {
  const rows = await db
    .insert(rawMessage)
    .values({
      platformMessageId: m.message.platform_message_id,
      chatId: m.message.chat_id,
      accountId: m.accountId,
      orderId: m.message.order_id,
      author: m.message.author,
      sentAt: m.message.sent_at,
      text: m.message.text,
      read: m.message.read,
      history: m.history ?? false,
    })
    .onConflictDoNothing()
    .returning({ id: rawMessage.platformMessageId })
  return rows.length > 0
}
