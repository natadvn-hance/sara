import {
  type AuthorBasis,
  type ChatAuthor,
  type ChatMessage,
  newEventId,
  normalizeText,
} from '@sara/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { chatMessage, outbox } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { ProfiClient } from '../profi/client'
import { getSettingChangedAt } from '../settings/store'
import type { ConversationRow, StoredMessage } from './types'

export type SyncResult = {
  /** Messages the core had not stored before, in the chat's order. */
  added: StoredMessage[]
  /** Of them, the ones from our side of the chat. */
  specialistAfter: StoredMessage[]
  /** A new message whose side the node could not tell (FR-CONV-2). */
  unclear: boolean
  /** The whole chat as stored, in the chat's order. */
  messages: StoredMessage[]
}

/** On the first reading a message older than this was there before Sara heard of it: its time is the reading's. */
const FRESH_MS = 10 * 60_000

export function storedOf(r: typeof chatMessage.$inferSelect): StoredMessage {
  return {
    id: r.id,
    accountId: r.accountId,
    chatId: r.chatId,
    orderId: r.orderId,
    platformMessageId: r.platformMessageId,
    side: r.side as StoredMessage['side'],
    author: r.author as ChatAuthor,
    authorBasis: r.authorBasis as AuthorBasis,
    text: r.text,
    sentAt: r.sentAt,
    approxTime: r.approxTime,
    read: r.read,
    source: r.source as StoredMessage['source'],
    conversationId: r.conversationId,
    heardAt: r.heardAt,
  }
}

/** The texts the new Sara sent to this chat, with whose words they were: her own, or Boris's dictated (ADR-024). */
async function ourTexts(db: Db, conv: ConversationRow): Promise<Map<string, 'sara' | 'boris'>> {
  const rows = await db
    .select({ kind: outbox.kind, payload: outbox.payload })
    .from(outbox)
    .where(inArray(outbox.kind, ['message', 'bid']))
  const texts = new Map<string, 'sara' | 'boris'>()
  for (const r of rows) {
    const p = r.payload as {
      chatId?: string
      accountId?: string
      leadId?: string
      text?: string
      author?: string
    }
    const mine =
      p.accountId === conv.accountId &&
      (r.kind === 'message' ? p.chatId === conv.chatId : p.leadId === conv.orderId)
    if (mine && typeof p.text === 'string')
      texts.set(
        normalizeText(p.text),
        r.kind === 'message' && p.author === 'boris' ? 'boris' : 'sara',
      )
  }
  return texts
}

/** The tail the site adds to a bid a moment after it: «Стоимость от 30000 до 45000 руб. усл. Контакты: +7…». */
const BID_TAIL = /^\s*Стоимость(?![\p{L}])[\s\S]{0,300}?(?:руб|₽)/iu
/** How near to the bid its tail lands (it was 1 ms in the chat of order 95583456). */
const BID_TAIL_MS = 10_000

/**
 * Whether a message is the site's tail of our bid, not someone writing (Boris, 31.10.2026: it made the conversation
 * Boris's and stopped the series): it follows the bid text we sent, right after it, and says what the bid costs.
 */
export function isBidTail(
  chat: readonly Pick<ChatMessage, 'author' | 'text' | 'sent_at' | 'platform_message_id'>[],
  m: Pick<ChatMessage, 'author' | 'text' | 'sent_at' | 'platform_message_id'>,
  ours: Map<string, 'sara' | 'boris'>,
): boolean {
  if (m.author !== 'specialist' || !BID_TAIL.test(m.text)) return false
  const i = chat.findIndex((x) => x.platform_message_id === m.platform_message_id)
  const before = i > 0 ? chat[i - 1] : undefined
  return (
    before?.author === 'specialist' &&
    ours.get(normalizeText(before.text)) === 'sara' &&
    Math.abs(Date.parse(m.sent_at) - Date.parse(before.sent_at)) <= BID_TAIL_MS
  )
}

/**
 * Whose voice a live message is (ADR-024). Old Sara's own evidence is known only to the history export (part A);
 * live, a message from our side is the new Sara's when her outbox holds its text, and Boris's only when it is
 * proved to be after the switch: `afterSwitch` says the chat was already known to Sara, and the message was written
 * and heard after old Sara stopped writing. Anything else may be old Sara's or Boris's, nobody's for sure.
 */
export function liveAuthor(
  m: Pick<ChatMessage, 'author' | 'text'>,
  ours: Map<string, 'sara' | 'boris'>,
  afterSwitch: boolean,
): { author: ChatAuthor; basis: AuthorBasis } {
  if (m.author === 'client') return { author: 'client', basis: 'side' }
  if (m.author === 'system') return { author: 'system', basis: 'side' }
  if (m.author === 'unknown') return { author: 'unknown', basis: 'side' }
  const sent = ours.get(normalizeText(m.text))
  // Boris's text the new Sara sent for him («Написать текст») is his voice.
  if (sent === 'boris') return { author: 'boris', basis: 'say' }
  if (sent === 'sara') return { author: 'sara', basis: 'outbox' }
  if (afterSwitch) return { author: 'boris', basis: 'after_cutover' }
  return { author: 'unknown', basis: 'v1_or_boris' }
}

/**
 * Reads the chat through Profi-MCP and stores what is new (FR-CONV-1, FR-CONV-2). Events carry the platform numbers
 * and authors only, never the text (ADR-022).
 */
export async function syncChat(
  d: {
    db: Db
    profi: ProfiClient
    /**
     * Told what is new in the chat the moment it is stored, whoever reads the chat (an event, a waiting turn, a check):
     * a client's word reaches Boris once, by whichever read stored it first. Its failure never stops the reading.
     */
    show?: (conv: ConversationRow, added: StoredMessage[]) => Promise<void>
  },
  conv: ConversationRow,
  heardAt: Date,
  o: { v1Writes: boolean },
): Promise<SyncResult> {
  const { messages: chat } = await d.profi.readChat(conv.accountId, conv.chatId)
  const known = await d.db
    .select()
    .from(chatMessage)
    .where(and(eq(chatMessage.accountId, conv.accountId), eq(chatMessage.chatId, conv.chatId)))
  const byId = new Map(known.map((r) => [r.platformMessageId, storedOf(r)]))
  // The chat is new to Sara when she has stored nothing of it herself: the copies of old Sara's export do not count.
  const first = !known.some((r) => r.source === 'node')
  // The moment old Sara stopped writing: when the setting was turned off (ADR-024). Without it nothing is proved.
  const switchedAt = o.v1Writes ? null : await getSettingChangedAt(d.db, 'conv.v1_writes')
  const switchedMs = switchedAt ? new Date(switchedAt).getTime() : null
  const fresh = chat.filter((m) => !byId.has(m.platform_message_id))
  const ours = fresh.some((m) => m.author === 'specialist')
    ? await ourTexts(d.db, conv)
    : new Map<string, 'sara' | 'boris'>()
  const added: StoredMessage[] = []
  for (const m of fresh) {
    const approx = first && heardAt.getTime() - new Date(m.sent_at).getTime() > FRESH_MS
    const who = isBidTail(chat, m, ours)
      ? ({ author: 'sara', basis: 'outbox' } as const)
      : liveAuthor(
          m,
          ours,
          !first &&
            switchedMs !== null &&
            new Date(m.sent_at).getTime() > switchedMs &&
            heardAt.getTime() > switchedMs,
        )
    const [row] = await d.db
      .insert(chatMessage)
      .values({
        id: newEventId(),
        accountId: conv.accountId,
        chatId: conv.chatId,
        orderId: conv.orderId,
        platformMessageId: m.platform_message_id,
        side: m.author,
        author: who.author,
        authorBasis: who.basis,
        text: m.text,
        sentAt: m.sent_at,
        approxTime: approx,
        // The page's mark on our side's messages is not the client's reading yet (design 5.11): only the read event.
        read: m.author === 'specialist' ? false : m.read,
        source: 'node',
        conversationId: conv.id,
        heardAt: heardAt.toISOString(),
      })
      .onConflictDoNothing()
      .returning()
    if (!row) {
      // Another sync stored it between our reading and this insert: the chat as stored is still whole.
      const [other] = await d.db
        .select()
        .from(chatMessage)
        .where(
          and(
            eq(chatMessage.accountId, conv.accountId),
            eq(chatMessage.platformMessageId, m.platform_message_id),
          ),
        )
      if (other) byId.set(other.platformMessageId, storedOf(other))
      continue
    }
    const s = storedOf(row)
    added.push(s)
    byId.set(s.platformMessageId, s)
    await appendEvent(d.db, {
      type: 'conv.message_heard',
      v: 1,
      entity: { kind: 'conversation', id: conv.id },
      account_id: conv.accountId,
      actor: 'profi',
      occurred_at: heardAt.toISOString(),
      causation_id: null,
      correlation_id: conv.id,
      reason: null,
      payload: {
        platform_message_id: s.platformMessageId,
        side: s.side,
        author: s.author,
        author_basis: s.authorBasis,
      },
    })
  }
  const messages = chat
    .map((m) => byId.get(m.platform_message_id))
    .filter((m): m is StoredMessage => m !== undefined)
  if (added.length > 0)
    await d.show?.(conv, added).catch((e) => console.error('news of the chat not shown', e))
  return {
    added,
    specialistAfter: added.filter((m) => m.side === 'specialist'),
    unclear: added.some((m) => m.side === 'unknown'),
    messages,
  }
}
