import { type EventEnvelope, normalizeText } from '@sara/shared'
import { and, eq, lte, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { chatMessage, conversation, lead, outbox } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { isApprovedText } from '../leads/callSlots'
import { firstName } from '../leads/clientName'
import { markShown, unmarkShown } from '../notify/forum'
import type { Notifier } from '../notify/notifier'
import { clientPost, ourPost } from '../notify/topicPosts'
import type { ProfiClient } from '../profi/client'
import { getSetting } from '../settings/store'
import { applyOwnerRule, ensureConversation, rowOf, updateConversation } from './store'
import { looksLikeBidTail, syncChat } from './sync'
import { CONV_TEXTS } from './texts'
import type { ConversationRow, StoredMessage } from './types'

export type ConversationEventDeps = {
  db: Db
  profi: ProfiClient
  notifier: Pick<Notifier, 'sendText'>
  /** The client wrote and conversations are on: the turn of this conversation starts or wakes (part C3). */
  onTurnNeeded(conv: ConversationRow, now: Date): Promise<void>
  /** The client types: a waiting turn wakes and waits again (FR-CONV-7). */
  onTyping(conv: ConversationRow): Promise<void>
  /** Our side wrote: a shadow turn compares its draft with it (M4 design 5.12). */
  onSpecialist(conv: ConversationRow, added: StoredMessage[]): Promise<void>
  /** The chat as read, whole: the reminders follow it (FR-CONV-12). Its failure never stops the reading. */
  onChatState?(conv: ConversationRow, messages: StoredMessage[]): Promise<void>
  /** What is new in a chat, for the reader of a call booked in it (the meeting card). */
  onNews?(conv: ConversationRow, added: StoredMessage[]): Promise<void>
  /** Our sent message is shown in the topic: the discussion of it leaves (the topic chat spec, section 5). */
  onOurs?(conv: ConversationRow): Promise<unknown>
}

/** After three unclear authors in a row Boris hears of it once (FR-CONV-2). */
const UNCLEAR_TELL_AT = 3

type Ref = { chat_id: string; order_id?: string | null; platform_message_id?: string | null }

async function noteUnclear(d: ConversationEventDeps, conv: ConversationRow, id: string | null) {
  const [row] = await d.db
    .update(conversation)
    .set({
      unclearCount: sql`${conversation.unclearCount} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(conversation.id, conv.id))
    .returning()
  if (!row) return
  const after = rowOf(row)
  await appendEvent(d.db, {
    type: 'conv.author_unclear',
    v: 1,
    entity: { kind: 'conversation', id: conv.id },
    account_id: conv.accountId,
    actor: 'profi',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: conv.id,
    reason: null,
    payload: { platform_message_id: id, count: after.unclearCount },
  })
  if (after.unclearCount === UNCLEAR_TELL_AT)
    await d.notifier.sendText(CONV_TEXTS.authorUnclear(conv.chatId), {
      place: { conversation: conv.id },
    })
}

/**
 * Every new client message goes to Boris at once, to the client's topic (Boris, 31.10: the draft waits for the quiet
 * time, the words must not). Several in a row are shown one by one; the one draft comes after them. A failed send
 * never stops the turn.
 */
export async function showClientWords(
  d: {
    db: Db
    notifier: Pick<Notifier, 'sendText'>
    onOurs?(conv: ConversationRow): Promise<unknown>
  },
  conv: ConversationRow,
  added: StoredMessage[],
) {
  if (added.length === 0 || !(await getSetting(d.db, 'pipeline.conversations'))) return
  const [l] = conv.orderId ? await d.db.select().from(lead).where(eq(lead.id, conv.orderId)) : []
  const key = conv.orderId ?? `conv:${conv.id}`
  const name = l?.clientName ? firstName(l.clientName) : null
  // What the topic shows already (the bid and the series are posted when they go, not read back from the chat).
  const posted = (l?.draftFollowUps ?? []) as string[]
  const bids = conv.orderId
    ? await d.db
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(and(eq(outbox.kind, 'bid'), sql`${outbox.payload}->>'leadId' = ${conv.orderId}`))
    : []
  const bidTexts = new Set(
    bids.map((b) => normalizeText((b.payload as { text?: string }).text ?? '')),
  )
  for (const m of added) {
    if (m.text.trim() === '') continue
    const mine =
      m.side === 'specialist' &&
      (m.authorBasis === 'outbox' || m.authorBasis === 'say') &&
      !posted.some((f) => isApprovedText(f, m.text)) &&
      !bidTexts.has(normalizeText(m.text)) &&
      !looksLikeBidTail(m.text)
    if (m.side !== 'client' && !mine) continue
    try {
      if (!(await markShown(d.db, key, `msg:${m.platformMessageId}`))) continue
      await d.notifier.sendText(
        m.side === 'client'
          ? clientPost({ name, at: m.sentAt, text: m.text })
          : ourPost({ at: m.sentAt, text: m.text }),
        {
          html: true,
          place: { conversation: conv.id },
          ...(m.side === 'client' ? {} : { quiet: true }),
        },
      )
      if (m.side !== 'client') await d.onOurs?.(conv).catch(() => {})
    } catch (e) {
      await unmarkShown(d.db, key, `msg:${m.platformMessageId}`).catch(() => {})
      console.error('chat message not shown', e instanceof Error ? e.message : e)
    }
  }
}

/**
 * What a chat's news does to its conversation: the chat is read and stored, the owner rule applied, our side's new
 * messages go to the comparison and a clear client message starts a turn (FR-CONV-1, FR-CONV-2, FR-CONV-10).
 */
export async function onChatNews(
  d: ConversationEventDeps,
  conv0: ConversationRow,
  now: Date,
  o: { clientHeard: boolean },
): Promise<void> {
  let conv = o.clientHeard
    ? await updateConversation(d.db, conv0.id, { lastClientHeardAt: now.toISOString() })
    : conv0
  const v1Writes = await getSetting(d.db, 'conv.v1_writes')
  const r = await syncChat(
    { db: d.db, profi: d.profi, show: (c, a) => showClientWords(d, c, a), news: d.onNews },
    conv,
    now,
    { v1Writes },
  )
  conv = await applyOwnerRule(d.db, conv, r.added, { v1Writes })
  try {
    await d.onChatState?.(conv, r.messages)
  } catch (e) {
    console.error('reminders could not follow the chat', e instanceof Error ? e.message : e)
  }
  if (r.unclear) {
    for (const m of r.added.filter((x) => x.side === 'unknown'))
      await noteUnclear(d, conv, m.platformMessageId)
    return
  }
  if (r.specialistAfter.length > 0) await d.onSpecialist(conv, r.specialistAfter)
  // The site's own lines («Сообщите, если договоритесь…») come right behind a client's word and must never hide it
  // (Boris, 31.10: the first answer of a real client got no turn and no card).
  const last = r.messages.findLast((m) => m.side !== 'system')
  if (last?.side === 'client') {
    if (conv.unclearCount > 0) conv = await updateConversation(d.db, conv.id, { unclearCount: 0 })
    if (await getSetting(d.db, 'pipeline.conversations')) await d.onTurnNeeded(conv, now)
  }
}

/** Profi events about chats (C2): each is safe to get twice, the sync stores a message once. */
export function createConversationEvents(
  d: ConversationEventDeps,
): (e: EventEnvelope) => Promise<void> {
  return async (e) => {
    const accountId = e.account_id ?? ''
    const p = e.payload as Ref
    if (!accountId || !p.chat_id) return
    const now = new Date()
    const conv = await ensureConversation(d.db, {
      accountId,
      chatId: p.chat_id,
      orderId: p.order_id ?? null,
    })
    switch (e.type) {
      case 'profi.client_message':
        return onChatNews(d, conv, now, { clientHeard: true })
      case 'profi.specialist_message':
        return onChatNews(d, conv, now, { clientHeard: false })
      case 'profi.author_unclear':
        return noteUnclear(d, conv, p.platform_message_id ?? null)
      case 'profi.client_typing': {
        const after = await updateConversation(d.db, conv.id, { typingAt: now.toISOString() })
        return d.onTyping(after)
      }
      case 'profi.client_read':
        return markRead(d.db, conv, p.platform_message_id ?? null)
      default:
        return
    }
  }
}

/** The client read our messages up to this one (all of ours when the number is not known). */
async function markRead(db: Db, conv: ConversationRow, platformMessageId: string | null) {
  const [upTo] = platformMessageId
    ? await db
        .select({ sentAt: chatMessage.sentAt })
        .from(chatMessage)
        .where(
          and(
            eq(chatMessage.accountId, conv.accountId),
            eq(chatMessage.platformMessageId, platformMessageId),
          ),
        )
    : []
  await db
    .update(chatMessage)
    .set({ read: true })
    .where(
      and(
        eq(chatMessage.conversationId, conv.id),
        eq(chatMessage.side, 'specialist'),
        ...(upTo ? [lte(chatMessage.sentAt, upTo.sentAt)] : []),
      ),
    )
}
