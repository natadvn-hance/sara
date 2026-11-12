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

export type BidAttempt = {
  dueRub: number
  result: unknown
  walletRub: number | null
  pressedAt: string
}

export async function findBidAttempt(db: NodeDbOrTx, key: string): Promise<BidAttempt | null> {
  const [r] = await db
    .select({
      dueRub: bidAttempt.dueRub,
      result: bidAttempt.result,
      walletRub: bidAttempt.walletRub,
      pressedAt: bidAttempt.pressedAt,
    })
    .from(bidAttempt)
    .where(eq(bidAttempt.idempotencyKey, key))
  return r ?? null
}

/** What the presses of this account after this one may have taken from the wallet: their money is not this press's. */
export async function duesPressedAfter(
  db: NodeDbOrTx,
  accountId: string,
  key: string,
): Promise<number> {
  const [r] = await db
    .select({ rub: sql<string | null>`sum(${bidAttempt.dueRub})` })
    .from(bidAttempt)
    .where(
      and(
        eq(bidAttempt.accountId, accountId),
        sql`${bidAttempt.pressedAt} > (select pressed_at from node.bid_attempt where idempotency_key = ${key})`,
      ),
    )
  return Number(r?.rub ?? 0)
}

/** Written before the send button is pressed: false when a press with this key was already written. */
export async function savePress(
  db: NodeDbOrTx,
  p: { key: string; accountId: string; orderId: string; dueRub: number; walletRub?: number | null },
): Promise<boolean> {
  const rows = await db
    .insert(bidAttempt)
    .values({
      idempotencyKey: p.key,
      accountId: p.accountId,
      orderId: p.orderId,
      dueRub: p.dueRub,
      walletRub: p.walletRub ?? null,
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

/**
 * True when this platform message was not stored before. A message of ours is stored unread whatever the page said:
 * `read` on ours is the client's reading, which only the chat's own answer tells (markReadByClient).
 */
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
      read: m.message.author === 'specialist' ? false : m.message.read,
      history: m.history ?? false,
    })
    .onConflictDoNothing()
    .returning({ id: rawMessage.platformMessageId })
  return rows.length > 0
}

/** A chat where the client read messages of ours the node held unread: the last of them, by the chat's order. */
export type ClientRead = {
  chatId: string
  orderId: string | null
  platformMessageId: string
  /** The core knows the chat: the node holds a message of it that went out as news, not only history. */
  known: boolean
}

/**
 * The core heard of this chat from the node: one of its messages went out as news. A chat with history alone is from
 * before Sara watched; an event about it would make the core an empty conversation.
 */
export const KNOWN_CHAT = (accountId: string, chatId: unknown) =>
  sql`exists (select 1 from node.raw_message k
    where k.account_id = ${accountId} and k.chat_id = ${chatId} and not k.history)`

/**
 * The client read these messages: ours among them that the node held unread become read, with ours before them in
 * the same chat (a client who read the last one has read the chat up to it). One entry a chat with such a change;
 * nothing for a read already known, so a chat answer read again changes nothing.
 */
export async function markReadByClient(
  db: NodeDbOrTx,
  accountId: string,
  messageIds: string[],
): Promise<ClientRead[]> {
  if (messageIds.length === 0) return []
  const res = await db.execute<{
    chat_id: string
    order_id: string | null
    platform_message_id: string
    known: boolean
  }>(sql`
    with named as (
      select chat_id, max(sent_at) as up_to from node.raw_message
      where account_id = ${accountId} and author = 'specialist' and not read
        and platform_message_id in (${sql.join(
          messageIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      group by chat_id
    ), changed as (
      update node.raw_message m set read = true
      from named n
      where m.account_id = ${accountId} and m.chat_id = n.chat_id and m.author = 'specialist' and not m.read
        and m.sent_at <= n.up_to
      returning m.chat_id, m.order_id, m.platform_message_id, m.sent_at
    )
    select distinct on (c.chat_id) c.chat_id, c.order_id, c.platform_message_id,
      ${KNOWN_CHAT(accountId, sql`c.chat_id`)} as known
    from changed c
    order by c.chat_id, c.sent_at desc, c.platform_message_id desc`)
  return res.rows.map((r) => ({
    chatId: r.chat_id,
    orderId: r.order_id,
    platformMessageId: r.platform_message_id,
    known: r.known,
  }))
}
