import { createHash } from 'node:crypto'
import {
  CHAT_AUTHORS,
  type ChatAuthor,
  type MessageSide,
  newEventId,
  normalizeText,
  plural,
} from '@sara/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { chatMessage, conversation, outbox, setting, settingHistory } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { type AttributionContext, attribute, V1_ATTACHMENT } from './attribution'
import type { V1Lead } from './v1Snapshot'

export type ExportReport = {
  chats: number
  messages: Record<ChatAuthor, number>
  /** Specialist messages with no proof of whose they are (v1 or Boris, ADR-024). */
  unknownSpecialist: number
  /** Messages known only from the v1 snapshot, with an approximate time. */
  v1Only: number
  borisMessages: number
  /** The short line for Boris: «Нашла 23 диалога, 140 твоих сообщений». */
  line: string
}

type RawRow = {
  platform_message_id: string
  chat_id: string
  order_id: string | null
  author: string
  sent_at: Date | string
  text: string
  read: boolean
  history: boolean
}

type NewMessage = typeof chatMessage.$inferInsert

/** The export's author replaces a stored one only when that one had no proof, or was Boris's text taken for Sara's. */
const UPGRADE = sql`((${chatMessage.authorBasis} = 'v1_or_boris' and excluded.author_basis <> 'v1_or_boris') or (${chatMessage.authorBasis} = 'outbox' and excluded.author_basis = 'say'))`

const iso = (v: Date | string) => new Date(v).toISOString()
const paragraphs = (s: string | null) => (s ?? '').split(/\n\s*\n/).filter((p) => p.trim() !== '')
/** v1 glued several messages with a blank line: a copy matches the whole message or one of its paragraphs. */
const textKeys = (side: string, text: string) =>
  [text, ...paragraphs(text)].map((t) => `${side}:${normalizeText(t)}`)
/** Paragraphs of one v1 field keep their order: each gets the next millisecond. */
const plusMs = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString()
/** v1 kept only the last 1000 characters of Boris's words: past that, the first paragraph starts mid-sentence. */
const BORIS_TEXT_LIMIT = 1000

/**
 * The number of a message known only from the v1 snapshot: by its words, not its place, so a newer snapshot whose
 * field v1 cut or rewrote adds its new words instead of colliding with the old ones (M4 design 5.1).
 */
export function v1MessageId(orderId: string, kind: string, text: string): string {
  const hash = createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 12)
  return `v1:${orderId}:${kind}:${hash}`
}

/** When old Sara stopped writing: the latest change of conv.v1_writes to false, while it is still false. */
export async function v1StoppedAt(db: Db): Promise<string | null> {
  const [now] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, 'conv.v1_writes'))
  if (now?.value !== false) return null
  const [off] = await db
    .select({ at: settingHistory.changedAt })
    .from(settingHistory)
    .where(
      and(eq(settingHistory.key, 'conv.v1_writes'), sql`${settingHistory.value} = 'false'::jsonb`),
    )
    .orderBy(desc(settingHistory.changedAt))
    .limit(1)
  return off ? new Date(off.at).toISOString() : null
}

/** The new Sara's own sends for this account: confirmed bids by order and confirmed messages by chat. */
async function ourSends(db: Db, accountId: string) {
  const rows = await db
    .select({
      kind: outbox.kind,
      payload: outbox.payload,
      confirmedAt: outbox.confirmedAt,
      createdAt: outbox.createdAt,
    })
    .from(outbox)
    .where(and(eq(outbox.state, 'confirmed'), inArray(outbox.kind, ['bid', 'message'])))
  const bids = new Map<string, string>()
  const messages = new Map<string, AttributionContext['ourOutbox']>()
  for (const r of rows) {
    const p = r.payload as Record<string, unknown>
    if (p.accountId !== accountId || typeof p.text !== 'string') continue
    if (r.kind === 'bid' && typeof p.leadId === 'string') bids.set(p.leadId, p.text)
    if (r.kind === 'message' && typeof p.chatId === 'string') {
      const list = messages.get(p.chatId) ?? []
      list.push({
        text: p.text,
        at: iso(r.confirmedAt ?? r.createdAt),
        author: p.author === 'boris' ? 'boris' : 'sara',
      })
      messages.set(p.chatId, list)
    }
  }
  return { bids, messages }
}

/** What the snapshot holds of a chat the node never read: the bid, Boris's words, the client's last words. */
function v1OnlyMessages(accountId: string, lead: V1Lead, c: AttributionContext): NewMessage[] {
  const chatId = `v1:${lead.orderId}`
  const out: NewMessage[] = []
  const add = (
    kind: string,
    side: MessageSide,
    text: string,
    sentAt: string,
    who: ReturnType<typeof attribute>,
  ) =>
    out.push({
      id: newEventId(),
      accountId,
      chatId,
      orderId: lead.orderId,
      platformMessageId: v1MessageId(lead.orderId, kind, text),
      side,
      author: who.author,
      authorBasis: who.basis,
      text,
      sentAt,
      approxTime: true,
      source: 'v1',
    })
  if (lead.respondedAt && lead.draftResponse) {
    const m = { side: 'specialist' as const, text: lead.draftResponse, sentAt: lead.respondedAt }
    add(
      'bid',
      'specialist',
      m.text,
      m.sentAt,
      attribute({ ...m, approxTime: true, inBid: true }, c),
    )
  }
  const cut = (lead.borisWroteText ?? '').length >= BORIS_TEXT_LIMIT
  paragraphs(lead.borisWroteText).forEach((p, n) => {
    // The cut start of his words never matches a real message and is no whole message of his.
    if ((cut && n === 0) || p.trim() === V1_ATTACHMENT) return
    const at = plusMs(lead.borisWroteAt ?? lead.updatedAt, n)
    const m = { side: 'specialist' as const, text: p.trim(), sentAt: at, approxTime: true }
    // Checked like any message: a paragraph that also proves old Sara (her own reply kept among his words) is nobody's.
    add('boris', 'specialist', m.text, at, attribute(m, c))
  })
  paragraphs(lead.customerReply).forEach((p, n) => {
    add('client', 'client', p.trim(), plusMs(lead.updatedAt, n), {
      author: 'client',
      basis: 'side',
    })
  })
  return out
}

async function report(db: Db, accountId: string): Promise<Omit<ExportReport, 'line'>> {
  const groups = await db.execute<{ author: string; side: string; source: string; n: number }>(sql`
    select author, side, source, count(*)::int as n from core.chat_message
    where account_id = ${accountId} group by author, side, source`)
  const chats = await db.execute<{ n: number }>(sql`
    select count(distinct chat_id)::int as n from core.chat_message where account_id = ${accountId}`)
  const messages = Object.fromEntries(CHAT_AUTHORS.map((a) => [a, 0])) as Record<ChatAuthor, number>
  let unknownSpecialist = 0
  let v1Only = 0
  for (const g of groups.rows) {
    messages[g.author as ChatAuthor] = (messages[g.author as ChatAuthor] ?? 0) + g.n
    if (g.side === 'specialist' && g.author === 'unknown') unknownSpecialist += g.n
    if (g.source === 'v1') v1Only += g.n
  }
  return {
    chats: chats.rows[0]?.n ?? 0,
    messages,
    unknownSpecialist,
    v1Only,
    borisMessages: messages.boris,
  }
}

/**
 * Copies the chats the node has read (`node.raw_message`) into `core.chat_message` with whose voice each message
 * is, and adds what only the v1 snapshot knows for chats the node never read (FR-TRAIN-1, M4 design 5.1). A
 * repeated run adds nothing; a real message replaces the v1-only copy with the same text.
 */
export async function exportHistory(
  db: Db,
  o: {
    accountId: string
    v1: { leads: V1Lead[]; startedAt: string } | null
    telegramV1Texts: Set<string>
    /** Boris's own words old Sara sent for him, from the same Telegram export. */
    telegramBorisTexts?: Set<string>
    v1Writes: boolean
    /** When old Sara stopped writing (v1StoppedAt); null: unknown, so the switch proves nothing. */
    v1StoppedAt?: string | null
  },
): Promise<ExportReport> {
  const leads = new Map((o.v1?.leads ?? []).map((l) => [l.orderId, l]))
  const sends = await ourSends(db, o.accountId)
  const context = (chatId: string, orderId: string | null): AttributionContext => ({
    v1StartedAt: o.v1?.startedAt ?? null,
    lead: orderId ? (leads.get(orderId) ?? null) : null,
    v1Texts: o.telegramV1Texts,
    borisTexts: o.telegramBorisTexts,
    ourOutbox: sends.messages.get(chatId) ?? [],
    v1Writes: o.v1Writes,
    v1StoppedAt: o.v1StoppedAt ?? null,
    ourBid: orderId ? (sends.bids.get(orderId) ?? null) : null,
  })
  const conversations = new Map(
    (
      await db
        .select({ id: conversation.id, chatId: conversation.chatId })
        .from(conversation)
        .where(eq(conversation.accountId, o.accountId))
    ).map((c) => [c.chatId, c.id]),
  )
  const raw = await db.execute<RawRow>(sql`
    select platform_message_id, chat_id, order_id, author, sent_at, text, read, history
    from node.raw_message where account_id = ${o.accountId}
    order by chat_id, sent_at, platform_message_id`)
  const chats = new Map<string, RawRow[]>()
  for (const r of raw.rows) {
    const list = chats.get(r.chat_id) ?? []
    list.push(r)
    chats.set(r.chat_id, list)
  }

  let added = 0
  let replaced = 0
  const ordersRead = new Set<string>()
  for (const [chatId, rows] of chats) {
    const orderId = rows.find((r) => r.order_id !== null)?.order_id ?? null
    if (orderId) ordersRead.add(orderId)
    const c = context(chatId, orderId)
    let clientSeen = false
    const values: NewMessage[] = rows.map((r) => {
      const side = r.author as MessageSide
      const inBid = side === 'specialist' && !clientSeen
      if (side === 'client') clientSeen = true
      const sentAt = iso(r.sent_at)
      const who = attribute({ side, text: r.text, sentAt, approxTime: r.history, inBid }, c)
      return {
        id: newEventId(),
        accountId: o.accountId,
        chatId,
        orderId,
        platformMessageId: r.platform_message_id,
        side,
        author: who.author,
        authorBasis: who.basis,
        text: r.text,
        sentAt,
        approxTime: r.history,
        read: r.read,
        source: 'node',
        conversationId: conversations.get(chatId) ?? null,
      }
    })
    await db.transaction(async (tx) => {
      // A row the live sync (part C) stored first gets the export's proof: an unproven author is upgraded, Boris's
      // dictated text the live sync took for Sara's becomes his, and a row without its conversation joins it.
      const inserted = await tx
        .insert(chatMessage)
        .values(values)
        .onConflictDoUpdate({
          target: [chatMessage.accountId, chatMessage.platformMessageId],
          set: {
            author: sql`case when ${UPGRADE} then excluded.author else ${chatMessage.author} end`,
            authorBasis: sql`case when ${UPGRADE} then excluded.author_basis else ${chatMessage.authorBasis} end`,
            conversationId: sql`coalesce(${chatMessage.conversationId}, excluded.conversation_id)`,
          },
          setWhere: sql`${UPGRADE} or (${chatMessage.conversationId} is null and excluded.conversation_id is not null)`,
        })
        // xmax is 0 for a row this statement inserted, not for one it updated.
        .returning({ fresh: sql<boolean>`(xmax = 0)` })
      added += inserted.filter((r) => r.fresh).length
      if (!orderId) return
      // A v1 copy goes once its real message is here and proven (or the copy itself proves nothing either).
      const finals = await tx
        .select({ side: chatMessage.side, text: chatMessage.text, author: chatMessage.author })
        .from(chatMessage)
        .where(
          and(
            eq(chatMessage.accountId, o.accountId),
            eq(chatMessage.chatId, chatId),
            eq(chatMessage.source, 'node'),
          ),
        )
      const proven = new Set(
        finals.filter((v) => v.author !== 'unknown').flatMap((v) => textKeys(v.side, v.text)),
      )
      const any = new Set(finals.flatMap((v) => textKeys(v.side, v.text)))
      const copies = await tx
        .select({
          id: chatMessage.id,
          side: chatMessage.side,
          text: chatMessage.text,
          author: chatMessage.author,
        })
        .from(chatMessage)
        .where(
          and(
            eq(chatMessage.accountId, o.accountId),
            eq(chatMessage.orderId, orderId),
            eq(chatMessage.source, 'v1'),
          ),
        )
      const gone = copies
        .filter((v) => {
          const key = `${v.side}:${normalizeText(v.text)}`
          return proven.has(key) || (v.author === 'unknown' && any.has(key))
        })
        .map((v) => v.id)
      if (gone.length > 0) await tx.delete(chatMessage).where(inArray(chatMessage.id, gone))
      replaced += gone.length
      // What v1 alone remembers of this chat now sits with its real messages, but outside its conversation: its
      // times are made up, so a turn never reads it as the latest words (part C reads by conversation).
      await tx
        .update(chatMessage)
        .set({ chatId, conversationId: null })
        .where(
          and(
            eq(chatMessage.accountId, o.accountId),
            eq(chatMessage.orderId, orderId),
            eq(chatMessage.source, 'v1'),
          ),
        )
    })
  }

  const exported = await db
    .selectDistinct({ orderId: chatMessage.orderId })
    .from(chatMessage)
    .where(and(eq(chatMessage.accountId, o.accountId), eq(chatMessage.source, 'node')))
  for (const e of exported) if (e.orderId) ordersRead.add(e.orderId)
  for (const lead of leads.values()) {
    if (ordersRead.has(lead.orderId)) continue
    const values = v1OnlyMessages(o.accountId, lead, context(`v1:${lead.orderId}`, lead.orderId))
    if (values.length === 0) continue
    const inserted = await db
      .insert(chatMessage)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: chatMessage.id })
    added += inserted.length
  }

  const r = await report(db, o.accountId)
  await appendEvent(db, {
    type: 'history.exported',
    v: 1,
    entity: { kind: 'account', id: o.accountId },
    account_id: o.accountId,
    actor: 'sara',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: {
      chats: r.chats,
      messages: r.messages,
      unknown_specialist: r.unknownSpecialist,
      v1_only: r.v1Only,
      added,
      replaced,
    },
  })
  const line = `Нашла ${r.chats} ${plural(r.chats, ['диалог', 'диалога', 'диалогов'])}, ${r.borisMessages} ${plural(r.borisMessages, ['твоё сообщение', 'твоих сообщения', 'твоих сообщений'])}`
  return { ...r, line }
}

const AUTHOR_WORDS: Record<ChatAuthor, string> = {
  client: 'клиенты',
  boris: 'ты',
  sara: 'новая Сара',
  sara_v1: 'старая Сара',
  system: 'Профи.ру',
  unknown: 'не понять',
}

/** The whole report in plain words, for the command line. */
export function formatExportReport(r: ExportReport): string {
  const byAuthor = CHAT_AUTHORS.map((a) => `${AUTHOR_WORDS[a]} ${r.messages[a]}`).join(', ')
  return [
    r.line,
    `По авторам: ${byAuthor}.`,
    `Без доказательства, чьи они: ${r.unknownSpecialist} ${plural(r.unknownSpecialist, ['сообщение', 'сообщения', 'сообщений'])} со стороны Hance. Пока v1 пишет с того же аккаунта, такие сообщения не считаются твоими.`,
    `Только из базы v1, время примерное: ${r.v1Only}.`,
  ].join('\n')
}
