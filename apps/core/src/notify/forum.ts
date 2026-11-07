import type { FunnelStage } from '@sara/shared'
import { and, asc, eq } from 'drizzle-orm'
import { contactsLine, contactsOf } from '../conversation/contacts'
import type { DbOrTx } from '../db/client'
import {
  conversation,
  forumTopic,
  lead,
  telegramForum,
  telegramPost,
  topicShown,
} from '../db/schema'
import { firstName } from '../leads/clientName'
import type { Place } from './notifier'
import { introPost } from './topicPosts'

/** Boris's forum (docs/product/telegram-forum.md), null while he has none: then everything goes to his chat. */
export type Forum = {
  chatId: number
  title: string | null
  leadsThreadId: number | null
  analyticsThreadId?: number | null
}

export async function forumOf(db: DbOrTx): Promise<Forum | null> {
  const [f] = await db.select().from(telegramForum).where(eq(telegramForum.id, 1))
  return f
    ? {
        chatId: f.chatId,
        title: f.title,
        leadsThreadId: f.leadsThreadId,
        analyticsThreadId: f.analyticsThreadId,
      }
    : null
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

/**
 * The circle in front of a topic's name is the client's stage in Boris's funnel (the same stage the pult and the client
 * log show, Boris, 01.11); Telegram does not let a topic's icon colour change, so the colour is in the name. Boris will
 * correct the colours by his table (confirmed 01.11: Отклик жёлтый, Переговоры светло-зелёный, Отвалился красный,
 * Закрыта тёмно-зелёная, which Telegram has only as ✅; «В работе» he has not named, it stays orange).
 */
export const STAGE_DOT: Record<FunnelStage, string> = {
  Отклик: '🟡',
  Переговоры: '🟢',
  'В работе': '🟠',
  Закрыта: '✅',
  Отвалился: '🔴',
}
/** The circles of the stages and the ones of earlier colours, so that an old one never stays beside the new. */
const DOTS = [...Object.values(STAGE_DOT), '🔵', '🟢']
/** The name of a topic without the circle of its stage (any circle that was ever one, however many in a row). */
export const withoutDot = (name: string) => {
  let rest = name
  for (
    let dot = DOTS.find((x) => rest.startsWith(`${x} `));
    dot;
    dot = DOTS.find((x) => rest.startsWith(`${x} `))
  )
    rest = rest.slice(dot.length + 1)
  return rest
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** «Ирина · №95147898 · Сайт для салона», cut to fit with room for the closed mark. */
export function topicName(o: {
  name: string | null
  orderId: string | null
  title: string | null
  stage?: FunnelStage
}) {
  const dot = o.stage ? `${STAGE_DOT[o.stage]} ` : ''
  const head = [o.name && oneLine(o.name), o.orderId && `№${o.orderId}`].filter(Boolean).join(' · ')
  const room = NAME_MAX - CLOSED_MARK.length - dot.length - head.length - 3
  const title = o.title ? oneLine(o.title) : ''
  const cut = title.length > room ? `${title.slice(0, Math.max(room - 1, 0)).trimEnd()}…` : title
  return `${dot}${[head, cut].filter(Boolean).join(' · ') || 'Клиент'}`
}

/** The name of a new topic and its first message: what the order is, laid out (HTML). */
export async function topicIntro(
  db: DbOrTx,
  key: string,
): Promise<{ name: string; intro: string }> {
  const orderId = key.startsWith('conv:') ? null : key
  const [l] = orderId ? await db.select().from(lead).where(eq(lead.id, orderId)) : []
  // The stage is the pult's own (loaded here, not at the top: the pult reaches back into the notifier).
  const { stageForKey } = await import('../pult/clients')
  const stage = await stageForKey(db, key)
  const name = topicName({
    name: l?.clientName ? firstName(l.clientName) : null,
    orderId,
    title: l?.title ?? null,
    stage,
  })
  const intro = introPost({
    title: l?.title ?? null,
    orderId,
    clientName: l?.clientName ? firstName(l.clientName) : null,
    city: l?.city ?? null,
    budget: l?.budgetText ?? null,
    seenAt: l?.seenAt ?? null,
    text: l?.text ?? null,
    contacts: contactsLine(
      await contactsOf(
        db,
        { orderId, conversationId: orderId ? null : key.slice(5) },
        l?.clientName ? [firstName(l.clientName) ?? ''] : [],
      ),
    ),
  })
  return { name, intro }
}

/** What the topic shows of this key already. */
export async function shownRefs(db: DbOrTx, key: string): Promise<Set<string>> {
  const rows = await db
    .select({ ref: topicShown.ref })
    .from(topicShown)
    .where(eq(topicShown.key, key))
  return new Set(rows.map((r) => r.ref))
}

/** Writes down that the topic shows `ref`; false when it was written down already. */
export async function markShown(db: DbOrTx, key: string, ref: string): Promise<boolean> {
  const rows = await db
    .insert(topicShown)
    .values({ key, ref })
    .onConflictDoNothing()
    .returning({ ref: topicShown.ref })
  return rows.length > 0
}

export async function unmarkShown(db: DbOrTx, key: string, ref: string): Promise<void> {
  await db.delete(topicShown).where(and(eq(topicShown.key, key), eq(topicShown.ref, ref)))
}

/** The references of the bot's posts in a topic, the oldest first. */
export async function topicPostRefs(
  db: DbOrTx,
  chatId: number,
  threadId: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: telegramPost.id })
    .from(telegramPost)
    .where(and(eq(telegramPost.chatId, chatId), eq(telegramPost.threadId, threadId)))
    .orderBy(asc(telegramPost.messageId))
  return rows.map((r) => -r.id)
}

export async function renameTopic(
  db: DbOrTx,
  chatId: number,
  key: string,
  name: string,
): Promise<void> {
  await db
    .update(forumTopic)
    .set({ name })
    .where(and(eq(forumTopic.chatId, chatId), eq(forumTopic.key, key)))
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
  // A new topic made for this key shows nothing yet: what the dropped one showed is forgotten with it.
  await db.delete(topicShown).where(eq(topicShown.key, key))
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
