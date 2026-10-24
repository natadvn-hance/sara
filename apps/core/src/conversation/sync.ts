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

function storedOf(r: typeof chatMessage.$inferSelect): StoredMessage {
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

/** The texts the new Sara herself sent to this chat: her messages and her bid (ADR-024). */
async function ourTexts(db: Db, conv: ConversationRow): Promise<Set<string>> {
  const rows = await db
    .select({ kind: outbox.kind, payload: outbox.payload })
    .from(outbox)
    .where(inArray(outbox.kind, ['message', 'bid']))
  const texts = new Set<string>()
  for (const r of rows) {
    const p = r.payload as { chatId?: string; accountId?: string; leadId?: string; text?: string }
    const mine =
      p.accountId === conv.accountId &&
      (r.kind === 'message' ? p.chatId === conv.chatId : p.leadId === conv.orderId)
    if (mine && typeof p.text === 'string') texts.add(normalizeText(p.text))
  }
  return texts
}

/**
 * Whose voice a live message is (ADR-024). Old Sara's own evidence is known only to the history export (part A);
 * live, a message from our side is the new Sara's when her outbox holds its text, Boris's after the switch, and
 * nobody's for sure while old Sara still writes.
 */
export function liveAuthor(
  m: Pick<ChatMessage, 'author' | 'text'>,
  ours: Set<string>,
  v1Writes: boolean,
): { author: ChatAuthor; basis: AuthorBasis } {
  if (m.author === 'client') return { author: 'client', basis: 'side' }
  if (m.author === 'system') return { author: 'system', basis: 'side' }
  if (m.author === 'unknown') return { author: 'unknown', basis: 'side' }
  if (ours.has(normalizeText(m.text))) return { author: 'sara', basis: 'outbox' }
  if (!v1Writes) return { author: 'boris', basis: 'after_cutover' }
  return { author: 'unknown', basis: 'v1_or_boris' }
}

/**
 * Reads the chat through Profi-MCP and stores what is new (FR-CONV-1, FR-CONV-2). Events carry the platform numbers
 * and authors only, never the text (ADR-022).
 */
export async function syncChat(
  d: { db: Db; profi: ProfiClient },
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
  const first = known.length === 0
  const fresh = chat.filter((m) => !byId.has(m.platform_message_id))
  const ours = fresh.some((m) => m.author === 'specialist')
    ? await ourTexts(d.db, conv)
    : new Set<string>()
  const added: StoredMessage[] = []
  for (const m of fresh) {
    const who = liveAuthor(m, ours, o.v1Writes)
    const old = heardAt.getTime() - new Date(m.sent_at).getTime() > FRESH_MS
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
        approxTime: first && old,
        read: m.read,
        source: 'node',
        conversationId: conv.id,
        heardAt: heardAt.toISOString(),
      })
      .onConflictDoNothing()
      .returning()
    if (!row) continue
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
  return {
    added,
    specialistAfter: added.filter((m) => m.side === 'specialist'),
    unclear: added.some((m) => m.side === 'unknown'),
    messages,
  }
}
