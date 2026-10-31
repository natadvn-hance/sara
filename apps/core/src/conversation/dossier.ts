import { type ClientInfo, CONV_STAGES, type ConvStage } from '@sara/shared'
import { and, asc, eq, ne } from 'drizzle-orm'
import type { Db } from '../db/client'
import { chatMessage, convTurn, deal, lead } from '../db/schema'
import type { ProfiClient } from '../profi/client'
import { leadSiteOf } from '../site'
import { isNewMoscowDay } from './check/codeChecks'
import { NOT_NAMES } from './check/phrases'
import { getConversation } from './store'
import { inMoscowHours } from './time'
import type { ConversationRow, Dossier, DossierMessage } from './types'

/**
 * The client messages a turn answers: those after our side's last message and after the last message a finished
 * turn covered (FR-CONV-7, M4 design 5.7).
 */
export function turnMessageIds(
  messages: DossierMessage[],
  handledThrough: string | null,
): string[] {
  const lastOurs = messages.findLastIndex((m) => m.side === 'specialist')
  const handled = handledThrough
    ? messages.findIndex((m) => m.platformMessageId === handledThrough)
    : -1
  const from = Math.max(lastOurs, handled) + 1
  return messages
    .slice(from)
    .filter((m) => m.side === 'client')
    .map((m) => m.platformMessageId)
}

/**
 * The chat as it was when the turn began: in shadow our side may answer while the turn runs, and the draft is
 * written, and compared with that answer, as if the answer had not come yet (M4 design 5.9). The first message of
 * our side after the anchor and all that follows it are left out; with none after the anchor nothing changes.
 */
export function untilOurs<T extends DossierMessage>(messages: T[], anchor: string | null): T[] {
  const at = anchor ? messages.findIndex((m) => m.platformMessageId === anchor) : -1
  if (at < 0) return messages
  const cut = messages.findIndex((m, i) => i > at && m.side === 'specialist')
  return cut < 0 ? messages : messages.slice(0, cut)
}

/**
 * The names of the client to hide from the model (ADR-016): the lead's or the order page's (the dossier has the one
 * it found), and the name old Sara greeted the client with. She opened every chat «<Имя>, добрый день!» or
 * «<Имя>, здравствуйте», so a chat she began, with no lead in the core, has its name in the first words of our
 * side's earliest message: a capitalized word before the first comma.
 */
export async function clientNames(
  db: Db,
  conv: ConversationRow,
  dossier?: Pick<Dossier, 'clientName'>,
): Promise<string[]> {
  const known = dossier
    ? dossier.clientName
    : conv.orderId
      ? (await db.select({ name: lead.clientName }).from(lead).where(eq(lead.id, conv.orderId)))[0]
          ?.name
      : null
  const [first] = await db
    .select({ text: chatMessage.text })
    .from(chatMessage)
    .where(and(eq(chatMessage.conversationId, conv.id), eq(chatMessage.side, 'specialist')))
    .orderBy(asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))
    .limit(1)
  const greeted = /^\s*([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)\s*,/u.exec(first?.text ?? '')?.[1]
  const folded = greeted?.toLowerCase().replace(/ё/g, 'е') ?? ''
  const names = [known, greeted && !NOT_NAMES.has(folded) ? greeted : null]
  return [...new Map(names.flatMap((n) => (n ? [[n.toLowerCase(), n] as const] : []))).values()]
}

function stageOf(
  conv: ConversationRow,
  dealStage: string | null,
  messages: DossierMessage[],
): ConvStage {
  if (dealStage && (CONV_STAGES as readonly string[]).includes(dealStage))
    return dealStage as ConvStage
  return messages.some((m) => m.side === 'client') ? 'talking' : 'bid_sent'
}

/**
 * The memory part of the mind (design v3, section 5): everything the core knows about this client, built by code
 * from the database on every turn. A chat begun by old Sara's bid has no lead in the core: its order comes from the
 * node when it is known there.
 */
export async function buildDossier(
  db: Db,
  conversationId: string,
  now: Date,
  o: {
    night: { from: number; to: number }
    profi?: ProfiClient
    anchor?: string
    /** The turn this dossier is for: its own trace is not an earlier turn's. */
    turnId?: string
  },
): Promise<Dossier> {
  const conv = await getConversation(db, conversationId)
  if (!conv) throw new Error(`conversation ${conversationId} not found`)
  const rows = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.conversationId, conversationId))
    .orderBy(asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))
  const messages: DossierMessage[] = untilOurs(
    rows.map((r) => ({
      author: r.author as DossierMessage['author'],
      side: r.side as DossierMessage['side'],
      text: r.text,
      sentAt: r.sentAt,
      platformMessageId: r.platformMessageId,
    })),
    o.anchor ?? null,
  )
  const [l] = conv.orderId ? await db.select().from(lead).where(eq(lead.id, conv.orderId)) : []
  let order: Dossier['order'] = l
    ? { title: l.title, category: l.category, city: l.city, budgetText: l.budgetText, text: l.text }
    : null
  let clientName = l?.clientName || null
  const clientInfo = (l?.clientInfo as ClientInfo | null) ?? null
  if (!order && conv.orderId && o.profi) {
    const known = await o.profi.getOrder(conv.accountId, conv.orderId).catch(() => null)
    if (known) {
      order = {
        title: known.title,
        category: known.category,
        city: known.city,
        budgetText: known.budget_text,
        text: known.text,
      }
      clientName = known.client_name || null
    }
  }
  const firstClient = messages.findIndex((m) => m.side === 'client')
  const opening = messages
    .slice(0, firstClient === -1 ? messages.length : firstClient)
    .filter((m) => m.side === 'specialist')
  const bid = opening[0]
    ? { text: opening.map((m) => m.text).join('\n\n'), author: opening[0].author }
    : null
  const [d] = conv.dealId
    ? await db.select({ stage: deal.stage }).from(deal).where(eq(deal.id, conv.dealId))
    : []
  const lastOurs = messages.findLast((m) => m.side === 'specialist')
  return {
    conversationId,
    accountId: conv.accountId,
    scope: conv.accountId,
    order,
    clientName,
    clientInfo,
    site: leadSiteOf(l?.clientSite),
    bid,
    messages,
    turnMessageIds: turnMessageIds(messages, conv.handledThrough),
    borisNote: conv.borisNote,
    stage: stageOf(conv, d?.stage ?? null, messages),
    owner: conv.owner,
    ownerReason: conv.ownerReason,
    newDay: isNewMoscowDay(lastOurs?.sentAt ?? null, now),
    night: inMoscowHours(now, o.night),
    lastOursAt: lastOurs?.sentAt ?? null,
    remindersSent: 0,
    toldCases: await toldCases(db, conversationId, o.turnId),
  }
}

/**
 * The cases the client heard from our side in the earlier turns of this chat, each once: those in the traces
 * (`understanding.case`) of turns whose reply really went to the client (outcome «sent»). A shadow draft, a call to
 * Boris, a failed turn or one a message of ours cancelled told the client nothing. A case that a message of our side
 * names by its brand is told too, but that is read from the chat where the cases are (casesFor, caseIssues). The turn
 * being planned is left out: planning it again after CHAT_CHANGED must not call its own first try a repeat.
 */
async function toldCases(
  db: Db,
  conversationId: string,
  exceptTurn?: string,
): Promise<{ id: string; title: string }[]> {
  const rows = await db
    .select({ understanding: convTurn.understanding })
    .from(convTurn)
    .where(
      and(
        eq(convTurn.conversationId, conversationId),
        eq(convTurn.outcome, 'sent'),
        exceptTurn ? ne(convTurn.id, exceptTurn) : undefined,
      ),
    )
    .orderBy(asc(convTurn.createdAt), asc(convTurn.id))
  const told = new Map<string, string>()
  for (const r of rows) {
    const c = (
      r.understanding as { case?: { case_id?: string | null; title?: string } | null } | null
    )?.case
    if (c?.case_id && !told.has(c.case_id)) told.set(c.case_id, c.title ?? '')
  }
  return [...told].map(([id, title]) => ({ id, title }))
}
