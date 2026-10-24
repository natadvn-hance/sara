import { newEventId, type ProfiOrder } from '@sara/shared'
import type { NodeDbOrTx } from '../db/client'
import { rawEvent, rawMessage, rawOrder } from '../db/schema'

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
