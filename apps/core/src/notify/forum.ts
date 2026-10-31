import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { conversation, forumTopic, lead, telegramForum, telegramPost } from '../db/schema'
import type { Place } from './notifier'

/** Boris's forum (docs/product/telegram-forum.md), null while he has none: then everything goes to his chat. */
export type Forum = { chatId: number; title: string | null; leadsThreadId: number | null }

export async function forumOf(db: DbOrTx): Promise<Forum | null> {
  const [f] = await db.select().from(telegramForum).where(eq(telegramForum.id, 1))
  return f ? { chatId: f.chatId, title: f.title, leadsThreadId: f.leadsThreadId } : null
}

export async function bindForum(db: DbOrTx, f: Forum): Promise<void> {
  const now = new Date().toISOString()
  await db
    .insert(telegramForum)
    .values({ id: 1, ...f, boundAt: now })
    .onConflictDoUpdate({ target: telegramForum.id, set: { ...f, boundAt: now } })
}

export async function unbindForum(db: DbOrTx): Promise<void> {
  await db.delete(telegramForum).where(eq(telegramForum.id, 1))
}

/** A message in a forum as the core knows it: a negative number that no message of Boris's own chat has. */
export async function postRef(
  db: DbOrTx,
  chatId: number,
  messageId: number,
  threadId: number | null,
): Promise<number> {
  const [row] = await db
    .insert(telegramPost)
    .values({ chatId, messageId, threadId })
    .onConflictDoUpdate({
      target: [telegramPost.chatId, telegramPost.messageId],
      set: { messageId },
    })
    .returning({ id: telegramPost.id })
  if (!row) throw new Error('forum message was not recorded')
  return -row.id
}

/** The chat and the Telegram number of a forum message the core knows by `ref` (negative); null when unknown. */
export async function postOf(
  db: DbOrTx,
  ref: number,
): Promise<{ chatId: number; messageId: number } | null> {
  const [p] = await db
    .select({ chatId: telegramPost.chatId, messageId: telegramPost.messageId })
    .from(telegramPost)
    .where(eq(telegramPost.id, -ref))
  return p ?? null
}

export type Topic = typeof forumTopic.$inferSelect

/** The key of a client's topic: the order's number, or the conversation for a chat without one. */
export async function topicKey(
  db: DbOrTx,
  place: { conversation: string } | { order: string },
): Promise<{ key: string; conversationId: string | null } | null> {
  if ('order' in place) return { key: place.order, conversationId: null }
  const [c] = await db
    .select({ orderId: conversation.orderId })
    .from(conversation)
    .where(eq(conversation.id, place.conversation))
  if (!c) return null
  return { key: c.orderId ?? `conv:${place.conversation}`, conversationId: place.conversation }
}

export async function topicByKey(db: DbOrTx, chatId: number, key: string): Promise<Topic | null> {
  const [t] = await db
    .select()
    .from(forumTopic)
    .where(and(eq(forumTopic.chatId, chatId), eq(forumTopic.key, key)))
  return t ?? null
}

export async function topicByThread(
  db: DbOrTx,
  chatId: number,
  threadId: number,
): Promise<Topic | null> {
  const [t] = await db
    .select()
    .from(forumTopic)
    .where(and(eq(forumTopic.chatId, chatId), eq(forumTopic.threadId, threadId)))
  return t ?? null
}

/** The conversation a client's topic is about: kept on it, or found by its order once the client wrote. */
export async function conversationOfTopic(db: DbOrTx, t: Topic): Promise<string | null> {
  if (t.conversationId) return t.conversationId
  if (t.key.startsWith('conv:')) return t.key.slice(5)
  const [c] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.orderId, t.key))
  if (!c) return null
  await db
    .update(forumTopic)
    .set({ conversationId: c.id })
    .where(and(eq(forumTopic.chatId, t.chatId), eq(forumTopic.key, t.key)))
  return c.id
}

/** Telegram takes a topic name of 1-128 characters. */
const NAME_MAX = 128
export const CLOSED_MARK = ' · закрыт'

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** «Ирина · №95147898 · Сайт для салона», cut to fit with room for the closed mark. */
export function topicName(o: {
  name: string | null
  orderId: string | null
  title: string | null
}) {
  const head = [o.name && oneLine(o.name), o.orderId && `№${o.orderId}`].filter(Boolean).join(' · ')
  const room = NAME_MAX - CLOSED_MARK.length - head.length - 3
  const title = o.title ? oneLine(o.title) : ''
  const cut = title.length > room ? `${title.slice(0, Math.max(room - 1, 0)).trimEnd()}…` : title
  return [head, cut].filter(Boolean).join(' · ') || 'Клиент'
}

const orderUrl = (orderId: string) =>
  `https://profi.ru/backoffice/n.php?o=${encodeURIComponent(orderId)}`

/** The name of a new topic and its first message: what the order is, in a few lines, with its link. */
export async function topicIntro(
  db: DbOrTx,
  key: string,
): Promise<{ name: string; intro: string }> {
  const orderId = key.startsWith('conv:') ? null : key
  const [l] = orderId
    ? await db
        .select({ title: lead.title, clientName: lead.clientName, text: lead.text })
        .from(lead)
        .where(eq(lead.id, orderId))
    : []
  const name = topicName({ name: l?.clientName || null, orderId, title: l?.title ?? null })
  const text = l?.text ? oneLine(l.text) : ''
  const intro = [
    `📌 ${l?.title ?? (orderId ? `Заказ №${orderId}` : 'Клиент без заказа')}`,
    l?.clientName ? `Клиент: ${l.clientName}` : null,
    text ? (text.length > 400 ? `${text.slice(0, 399).trimEnd()}…` : text) : null,
    orderId ? orderUrl(orderId) : null,
    'Здесь всё по этому клиенту. Напиши сюда текст, и я предложу отправить его клиенту.',
  ]
    .filter(Boolean)
    .join('\n')
  return { name, intro }
}

export async function saveTopic(
  db: DbOrTx,
  t: { chatId: number; key: string; threadId: number; conversationId: string | null; name: string },
): Promise<void> {
  await db
    .insert(forumTopic)
    .values(t)
    .onConflictDoUpdate({
      target: [forumTopic.chatId, forumTopic.key],
      set: { threadId: t.threadId, name: t.name, closedAt: null },
    })
}

/** A topic made from the order before the client wrote learns its conversation. */
export async function linkTopic(
  db: DbOrTx,
  chatId: number,
  key: string,
  conversationId: string,
): Promise<void> {
  await db
    .update(forumTopic)
    .set({ conversationId })
    .where(and(eq(forumTopic.chatId, chatId), eq(forumTopic.key, key)))
}

export async function dropTopic(db: DbOrTx, chatId: number, key: string): Promise<void> {
  await db.delete(forumTopic).where(and(eq(forumTopic.chatId, chatId), eq(forumTopic.key, key)))
}

export async function markTopic(
  db: DbOrTx,
  chatId: number,
  key: string,
  closedAt: string | null,
): Promise<void> {
  await db
    .update(forumTopic)
    .set({ closedAt })
    .where(and(eq(forumTopic.chatId, chatId), eq(forumTopic.key, key)))
}

export const isClientPlace = (
  p: Place | undefined,
): p is { conversation: string } | { order: string } => typeof p === 'object' && p !== null
