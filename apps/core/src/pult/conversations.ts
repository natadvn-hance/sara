import {
  type ChatAuthor,
  type Tone as ClientTone,
  type ConvList,
  type ConvRow,
  type ConvView,
  shownTitle,
} from '@sara/shared'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { sendHold } from '../conversation/sendHold'
import { AUTHOR_RU, TONE_RU } from '../conversation/texts'
import type { Db, DbOrTx } from '../db/client'
import { chatMessage, conversation, convTurn, lead, mindIndex, task } from '../db/schema'
import { getSetting } from '../settings/store'
import { clientNames } from './feed'

/** «Переписки» (M7 design 5.4): who waits for Boris, whose client it is, the chat and the open draft. */

/** The open draft card of each conversation: the task and its turn. */
async function openDrafts(db: DbOrTx, conversationIds?: string[]) {
  const rows = await db
    .select({ t: task, turn: convTurn })
    .from(task)
    .innerJoin(convTurn, sql`${convTurn.id} = ${task.entityId}`)
    .where(
      and(
        eq(task.kind, 'conv_draft'),
        eq(task.state, 'open'),
        ...(conversationIds ? [inArray(convTurn.conversationId, conversationIds)] : []),
      ),
    )
    .orderBy(desc(task.createdAt))
  const out = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!out.has(r.turn.conversationId)) out.set(r.turn.conversationId, r)
  return out
}

/** While old Sara writes or the drafts wait for the switch, what a press on «Отправить» does, said once. */
async function draftingNote(db: DbOrTx): Promise<string | null> {
  if (await getSetting(db, 'conv.v1_writes'))
    return 'Пока пишет старая Сара, «Отправить» только запоминает твоё решение, клиенту ничего не уходит.'
  if (!(await getSetting(db, 'conv.autopilot')))
    return 'Режим черновиков: клиенту уходит только то, что ты отправил кнопкой «Отправить».'
  return null
}

export async function conversationList(db: DbOrTx): Promise<ConvList> {
  const convs = await db
    .select()
    .from(conversation)
    .orderBy(desc(conversation.updatedAt))
    .limit(200)
  const ids = convs.map((c) => c.id)
  const names = await clientNames(db, ids)
  const drafts = await openDrafts(db, ids)
  const lastRows = ids.length
    ? await db.execute<{
        conversation_id: string
        side: string
        author: string
        text: string
        sent_at: string
      }>(sql`
        select distinct on (conversation_id) conversation_id, side, author, text, sent_at
        from core.chat_message where conversation_id in ${ids}
        order by conversation_id, sent_at desc`)
    : { rows: [] }
  const last = new Map(lastRows.rows.map((r) => [r.conversation_id, r]))
  const orders = convs.map((c) => c.orderId).filter((x): x is string => !!x)
  const titles = orders.length
    ? new Map(
        (
          await db
            .select({ id: lead.id, title: lead.title })
            .from(lead)
            .where(inArray(lead.id, orders))
        ).map((l) => [l.id, shownTitle(l.id, l.title)]),
      )
    : new Map<string, string>()
  const rows: ConvRow[] = convs.map((c) => {
    const m = last.get(c.id)
    const group: ConvRow['group'] = c.closedAt
      ? 'closed'
      : drafts.has(c.id)
        ? 'waiting'
        : c.owner === 'boris'
          ? 'boris'
          : 'sara'
    return {
      id: c.id,
      name: names.get(c.id) ?? `Чат ${c.chatId}`,
      title: c.orderId ? (titles.get(c.orderId) ?? null) : null,
      group,
      last: m ? m.text.slice(0, 160) : null,
      lastAt: m ? new Date(m.sent_at).toISOString() : null,
      lastSide: m ? sideOf(m.side, m.author) : null,
    }
  })
  return { rows, drafting: await draftingNote(db) }
}

const authorOf = (a: string) => AUTHOR_RU[a as ChatAuthor] ?? a

/** Profi.ru's own lines in a chat («Вернули на баланс…») are neither the client's nor ours. */
const sideOf = (side: string, author: string): 'client' | 'us' | 'profi' =>
  author === 'system' ? 'profi' : side === 'client' ? 'client' : 'us'

/** The chat on Profi.ru (r.php, the chat page the node reads). */
const chatUrl = (chatId: string) =>
  `https://profi.ru/backoffice/r.php?id=${encodeURIComponent(chatId)}`

export async function conversationView(db: Db, id: string): Promise<ConvView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const [c] = await db.select().from(conversation).where(eq(conversation.id, id))
  if (!c) return null
  const names = await clientNames(db, [id])
  const [l] = c.orderId ? await db.select().from(lead).where(eq(lead.id, c.orderId)) : []
  const msgs = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.conversationId, id))
    .orderBy(asc(chatMessage.sentAt))
  const d = (await openDrafts(db, [id])).get(id)
  let draft: ConvView['draft'] = null
  if (d?.turn.text) {
    const u = d.turn.understanding as { why?: string; tone?: ClientTone } | null
    const factIds = (d.turn.factIds as string[] | null) ?? []
    const facts = factIds.length
      ? await db
          .select({ id: mindIndex.recordId, title: mindIndex.title })
          .from(mindIndex)
          .where(inArray(mindIndex.recordId, factIds))
      : []
    draft = {
      taskId: d.t.id,
      kind: d.turn.kind === 'reminder' ? 'reminder' : 'reply',
      text: d.turn.text,
      why: u?.why ?? d.turn.decisionReason ?? null,
      tone: u?.tone ? (TONE_RU[u.tone] ?? null) : null,
      facts,
      at: d.t.createdAt,
    }
  }
  return {
    id: c.id,
    name: names.get(id) ?? `Чат ${c.chatId}`,
    owner: c.owner === 'boris' ? 'boris' : 'sara',
    closed: c.closedAt !== null,
    orderId: c.orderId,
    orderTitle: l ? shownTitle(l.id, l.title) : null,
    chatUrl: chatUrl(c.chatId),
    note: c.borisNote,
    messages: msgs.map((m) => ({
      id: m.id,
      side: sideOf(m.side, m.author),
      author: authorOf(m.author),
      text: m.text,
      at: m.sentAt,
      approx: m.approxTime,
      read: m.read,
    })),
    draft,
    sendHold: draft
      ? (await getSetting(db, 'conv.v1_writes'))
        ? 'пока пишет старая Сара, клиенту ничего не уйдёт'
        : await sendHold(db, id, 'sara')
      : null,
  }
}

/** Open draft cards, for «Сегодня». */
export async function draftsWaiting(
  db: DbOrTx,
): Promise<{ conversationId: string; at: string; reminder: boolean }[]> {
  return [...(await openDrafts(db)).values()].map((r) => ({
    conversationId: r.turn.conversationId,
    at: r.t.createdAt,
    reminder: r.turn.kind === 'reminder',
  }))
}
