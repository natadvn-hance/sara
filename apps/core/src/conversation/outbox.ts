import { newEventId, normalizeText } from '@sara/shared'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { chatMessage, conversation, convTurn, outbox, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { isApprovedText } from '../leads/callSlots'
import type { BidPayload } from '../leads/outbox'
import { type ProfiClient, ProfiError } from '../profi/client'
import { getSetting } from '../settings/store'
import { hasBlockedLink } from '../text/blockedLinks'
import { getConversation } from './store'

export { SEND_TEXTS, type SendOptions } from './sendTexts'

export type MessagePayload = {
  accountId: string
  chatId: string
  text: string
  author: 'sara' | 'boris'
  /** The chat's last message the sender saw; the node refuses when the chat has moved on (CHAT_CHANGED). */
  expectLast: string | null
}

export type Delivery = 'confirmed' | 'changed' | 'uncertain' | 'failed'

async function event(
  db: DbOrTx,
  type: 'outbox.queued' | 'outbox.confirmed' | 'outbox.failed',
  outboxId: string,
  p: MessagePayload,
  extra: Record<string, unknown> = {},
) {
  await appendEvent(db, {
    type,
    v: 1,
    entity: { kind: 'outbox', id: outboxId },
    account_id: p.accountId,
    actor: p.author,
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: outboxId,
    reason: null,
    payload: { kind: 'message', chat_id: p.chatId, ...extra },
  })
}

/** The key of a text Boris sent with «Отправить» on a card: `send:<task id of the card>` (commands.ts). */
const PRESS_KEY = /^send:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * Whether the key stands for Boris's press on «Отправить» of the card this very message comes from: the task of a draft
 * or reminder card is there, he answered it with «send», its turn (or reminder row) is of this conversation and holds
 * exactly this text. A key that only looks like one, or the press of another card or text, is no press, so the line of
 * drafts mode cannot be crossed by naming a key.
 */
async function borisPressed(
  tx: DbOrTx,
  key: string,
  m: { accountId: string; chatId: string; text: string },
): Promise<boolean> {
  const id = PRESS_KEY.exec(key)?.[1]
  if (!id) return false
  const [t] = await tx
    .select({ entityId: task.entityId })
    .from(task)
    .where(
      and(
        eq(task.id, id),
        eq(task.kind, 'conv_draft'),
        eq(task.state, 'resolved'),
        eq(task.resolution, 'send'),
      ),
    )
  if (!t) return false
  const [turn] = await tx.select().from(convTurn).where(eq(convTurn.id, t.entityId))
  if (!turn || turn.text !== m.text) return false
  const conv = await getConversation(tx, turn.conversationId)
  return conv?.accountId === m.accountId && conv.chatId === m.chatId
}

/** The key of a message of the series after a bid: `series:<order>:<place>`, `:2` on its one try after the chat moved. */
const SERIES_KEY = /^series:([^:]+):([0-3])(?::2)?$/

/**
 * Whether the message is one of the series Boris approved with his press on «Откликнуться» (Boris, 29.10.2026): the bid
 * of that order went (its outbox row confirmed) from the press on its card, the text is the one at this place of the
 * series as it was when he pressed, and the chat is the order's. The series is approved with the bid and by nothing
 * else, so the line of drafts mode cannot be crossed by naming such a key.
 */
async function seriesApproved(
  tx: DbOrTx,
  key: string,
  m: { accountId: string; chatId: string; text: string },
): Promise<boolean> {
  const [, leadId, place] = SERIES_KEY.exec(key) ?? []
  if (!leadId || !place) return false
  const [bid] = await tx
    .select({ payload: outbox.payload })
    .from(outbox)
    .where(
      and(
        eq(outbox.kind, 'bid'),
        eq(outbox.state, 'confirmed'),
        sql`${outbox.payload}->>'leadId' = ${leadId}`,
      ),
    )
  const p = bid?.payload as BidPayload | undefined
  const approved = p?.followUps?.[Number(place)]
  if (!p?.taskId || p.accountId !== m.accountId || approved === undefined) return false
  // The text pressed, or for the call offer that text with only its times put in by the code.
  if (!isApprovedText(approved, m.text)) return false
  const [t] = await tx
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.id, p.taskId),
        eq(task.kind, 'lead_decision'),
        eq(task.state, 'resolved'),
        eq(task.resolution, 'bid'),
      ),
    )
  if (!t) return false
  // The chat of a bid is the order's own number, unless a conversation of the order names another.
  const [c] = await tx
    .select({ orderId: conversation.orderId })
    .from(conversation)
    .where(and(eq(conversation.accountId, m.accountId), eq(conversation.chatId, m.chatId)))
  return c?.orderId ? c.orderId === leadId : m.chatId === leadId
}

/**
 * A message to a client enters the outbox once per key (FR-CONV-9). Nothing is queued in shadow, not even Boris's
 * own text (ADR-024); Sara's own text also waits out the «Пишет клиентам» pause, Boris's text passes it (as v1).
 * In drafts mode (`conv.autopilot` off) the one line nothing crosses: a message of author sara goes only with Boris's
 * press on «Отправить», or for the series after a bid with his press on «Откликнуться»; his own text is his press
 * already (FR-CONV-5, FR-CONV-11). Null when it may not go now.
 */
export async function queueMessage(
  tx: DbOrTx,
  i: MessagePayload & { key: string },
): Promise<string | null> {
  if (await getSetting(tx, 'conv.v1_writes')) return null
  if (i.author === 'sara' && !(await getSetting(tx, 'outbound.messages'))) return null
  // Boris's own words are his; Sara's never carry a link a client is not to be given (links.blocked, 30.10.2026).
  if (i.author === 'sara' && hasBlockedLink(i.text, await getSetting(tx, 'links.blocked')))
    return null
  if (
    i.author === 'sara' &&
    !(await getSetting(tx, 'conv.autopilot')) &&
    !(await borisPressed(tx, i.key, i)) &&
    !(await seriesApproved(tx, i.key, i))
  )
    return null
  const { key, ...p } = i
  const id = newEventId()
  const rows = await tx
    .insert(outbox)
    .values({ id, kind: 'message', idempotencyKey: `msg:${key}`, payload: p })
    .onConflictDoNothing()
    .returning({ id: outbox.id })
  if (rows.length === 0) {
    const [old] = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(eq(outbox.idempotencyKey, `msg:${key}`))
    return old?.id ?? null
  }
  await event(tx, 'outbox.queued', id, p)
  return id
}

/** Our message is in the chat after it was queued: the send went through even if its answer was lost. */
async function foundInChat(d: { db: Db; profi: ProfiClient }, p: MessagePayload): Promise<boolean> {
  const { messages } = await d.profi.readChat(p.accountId, p.chatId)
  const want = normalizeText(p.text)
  const after = p.expectLast
    ? messages.findIndex((m) => m.platform_message_id === p.expectLast)
    : -1
  return messages
    .slice(after + 1)
    .some((m) => m.author === 'specialist' && normalizeText(m.text) === want)
}

/**
 * Delivers a queued message through Profi-MCP (FR-CONV-9, NFR-REL-4). A lost answer is checked in the chat before
 * a repeat, and the repeat goes with the same key, which the node never sends twice. CHAT_CHANGED sends nothing:
 * the turn plans again. Any other failure is not retried blindly.
 */
export async function deliverMessage(
  d: { db: Db; profi: ProfiClient },
  outboxId: string,
): Promise<Delivery> {
  const [row] = await d.db.select().from(outbox).where(eq(outbox.id, outboxId))
  if (!row || row.kind !== 'message') return 'failed'
  if (row.state === 'confirmed') return 'confirmed'
  if (row.state !== 'queued') return row.state === 'changed' ? 'changed' : 'failed'
  const p = row.payload as MessagePayload
  const mark = async (state: string, errorClass: string | null) =>
    d.db
      .update(outbox)
      .set({
        state,
        errorClass,
        attempts: row.attempts + 1,
        ...(state === 'confirmed' && { confirmedAt: new Date().toISOString() }),
      })
      .where(eq(outbox.id, outboxId))
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await d.profi.sendMessage({
        account_id: p.accountId,
        chat_id: p.chatId,
        text: p.text,
        expect_last_message_id: p.expectLast,
        idempotency_key: row.idempotencyKey,
      })
      await mark('confirmed', null)
      await event(d.db, 'outbox.confirmed', outboxId, p, {
        platform_message_id: r.platform_message_id,
      })
      return 'confirmed'
    } catch (e) {
      const cls = e instanceof ProfiError ? e.errorClass : 'UNCERTAIN'
      if (cls === 'CHAT_CHANGED') {
        await mark('changed', cls)
        await event(d.db, 'outbox.failed', outboxId, p, { error_class: cls })
        return 'changed'
      }
      if (cls !== 'UNCERTAIN') {
        await mark('failed', cls)
        await event(d.db, 'outbox.failed', outboxId, p, { error_class: cls })
        return 'failed'
      }
      if (await foundInChat(d, p).catch(() => false)) {
        await mark('confirmed', null)
        await event(d.db, 'outbox.confirmed', outboxId, p, { found_in_chat: true })
        return 'confirmed'
      }
    }
  }
  await mark('uncertain', 'UNCERTAIN')
  await event(d.db, 'outbox.failed', outboxId, p, { error_class: 'UNCERTAIN' })
  return 'uncertain'
}

/** The last message the core has of a chat: what the node must still see when it types (CHAT_CHANGED). */
export async function lastSeen(db: Db, conversationId: string): Promise<string | null> {
  const rows = await db
    .select({ id: chatMessage.platformMessageId })
    .from(chatMessage)
    .where(eq(chatMessage.conversationId, conversationId))
    .orderBy(asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))
  return rows.at(-1)?.id ?? null
}

/** Step 7 «отправить» of a turn after the switch: its text, once per round. */
export async function sendTurnReply(
  d: { db: Db; profi: ProfiClient },
  turnId: string,
  round: number,
  /** The last message of the chat the turn saw when it reread it; left out, the last one the core has. */
  seenLast?: string | null,
): Promise<Delivery> {
  const [t] = await d.db.select().from(convTurn).where(eq(convTurn.id, turnId))
  const conv = t ? await getConversation(d.db, t.conversationId) : null
  if (!t?.text || !conv) return 'failed'
  const expectLast = seenLast !== undefined ? seenLast : await lastSeen(d.db, conv.id)
  const id = await d.db.transaction((tx) =>
    queueMessage(tx, {
      key: `${turnId}:${round}`,
      accountId: conv.accountId,
      chatId: conv.chatId,
      text: t.text ?? '',
      author: 'sara',
      expectLast,
    }),
  )
  return id ? deliverMessage(d, id) : 'failed'
}
