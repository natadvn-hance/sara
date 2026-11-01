import { type NoticeKind, type NoticeList, type NoticeRow, newEventId } from '@sara/shared'
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { convTurn, notice, question, task } from '../db/schema'
import { htmlToPlain } from './cards'
import type { Notifier } from './notifier'

/**
 * The center of notifications (pult v2 design 6): every message Sara sends Boris on her own goes to Telegram, as
 * before, and gets a row here with its state: new, seen, done. A press or an answer anywhere closes both: the
 * Telegram card is marked by the resolver, and the row reads as done once its task or question is closed.
 */

/** What a send may say about itself; without it the kind is read off the text. */
export type NoticeHint = {
  kind?: NoticeKind
  title?: string
  link?: string | null
  taskId?: string | null
  questionId?: string | null
}

/** The same notice (kind and task) within this long is one notice (FR-NOTIF-3). */
const SAME_WITHIN_MS = 3600_000
const BODY_MAX = 400

/** The kind a text speaks of by its head, when the sender said nothing (the heads are the bot's own). */
export function classifyNotice(text: string): NoticeKind {
  const head = text.trimStart().slice(0, 40)
  if (/^(🚨|🔴|🚫)/.test(head)) return 'urgent'
  if (/^(📅|✅📅)/.test(head)) return 'meeting'
  if (/^💬/.test(head)) return 'client'
  if (/^(📥|📊)|Сегодня отсеяла|^Сводка|^Итоги|^За сутки|^За неделю/.test(head)) return 'summary'
  if (/^(🔔|📝)/.test(head)) return 'draft'
  return 'system'
}

/** The first line as the title, the rest as the body, both plain and short. */
function split(text: string): { title: string; body: string } {
  const plain = htmlToPlain(text)
    .replace(/[\u2013\u2014]/g, '-')
    .trim()
  const [first = '', ...rest] = plain.split('\n')
  const title =
    first
      .replace(/^[\p{Extended_Pictographic}\s]+/u, '')
      .trim()
      .slice(0, 160) || 'Сара'
  const body = rest.join('\n').trim().slice(0, BODY_MAX)
  return { title, body }
}

/** The task a message's buttons decide, from `t:<task>:<action>` in the first button. */
export function taskOfRows(rows: { callbackData: string }[][] | undefined): string | null {
  for (const row of rows ?? [])
    for (const b of row) {
      const m = /^t:([0-9a-f-]{36}):/i.exec(b.callbackData)
      if (m?.[1]) return m[1]
    }
  return null
}

/** The page of a task's thing: a lead's own page, or the client of a draft card. */
async function taskPath(db: DbOrTx, t: typeof task.$inferSelect): Promise<string | null> {
  if (t.entityKind === 'lead') return `/leads/${encodeURIComponent(t.entityId)}`
  if (t.entityKind === 'conv_turn') {
    const [turn] = await db
      .select({ c: convTurn.conversationId })
      .from(convTurn)
      .where(eq(convTurn.id, t.entityId))
    return turn ? `/clients/${turn.c}` : null
  }
  if (t.kind === 'rule_proposal') return '/settings'
  return null
}

export async function recordNotice(
  db: DbOrTx,
  n: {
    kind: NoticeKind
    title: string
    body: string
    link: string | null
    taskId?: string | null
    questionId?: string | null
    telegramMessageId?: number | null
  },
): Promise<string | null> {
  if (n.taskId) {
    const since = new Date(Date.now() - SAME_WITHIN_MS).toISOString()
    const [same] = await db
      .select({ id: notice.id })
      .from(notice)
      .where(and(eq(notice.taskId, n.taskId), eq(notice.kind, n.kind), gt(notice.createdAt, since)))
      .limit(1)
    if (same) return null
  }
  const id = newEventId()
  await db.insert(notice).values({
    id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    link: n.link,
    taskId: n.taskId ?? null,
    questionId: n.questionId ?? null,
    telegramMessageId: n.telegramMessageId ?? null,
  })
  return id
}

/** A text message from the bot becomes a notice: the kind from the hint or the text, the task from its buttons. */
export async function noticeOfMessage(
  db: DbOrTx,
  text: string,
  o: { rows?: { callbackData: string }[][]; hint?: NoticeHint; messageId: number },
): Promise<string | null> {
  const taskId = o.hint?.taskId ?? taskOfRows(o.rows)
  let kind = o.hint?.kind
  let link = o.hint?.link ?? null
  if (taskId) {
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    if (t) {
      kind ??= t.kind.startsWith('conv_') ? 'draft' : t.kind === 'rule_proposal' ? 'system' : 'lead'
      link ??= await taskPath(db, t)
    }
  }
  const { title, body } = split(text)
  return recordNotice(db, {
    kind: kind ?? classifyNotice(text),
    title: o.hint?.title ?? title,
    body,
    link,
    taskId,
    questionId: o.hint?.questionId ?? null,
    telegramMessageId: o.messageId,
  })
}

/** Every send of the bot leaves a notice; the Telegram message itself is not touched. */
export function withNoticeLog(
  n: Notifier,
  db: Db,
  /** A new notice (not a repeat within the hour): the phone and the computer ring (Web Push). */
  onNotice?: (kind: NoticeKind) => void,
): Notifier {
  const log = (p: Promise<string | null>, kind: () => Promise<NoticeKind | null>) =>
    p
      .then(async (id) => {
        if (!id || !onNotice) return
        const k = await kind()
        if (k) onNotice(k)
      })
      .catch((e: unknown) =>
        console.error('notice not recorded', e instanceof Error ? e.message.slice(0, 200) : e),
      )
  const kindOf = async (recorded: Promise<string | null>): Promise<NoticeKind | null> => {
    const id = await recorded
    if (!id) return null
    const [row] = await db.select({ kind: notice.kind }).from(notice).where(eq(notice.id, id))
    return (row?.kind as NoticeKind | undefined) ?? null
  }
  return {
    ...n,
    async sendLeadCard(c, o) {
      const m = await n.sendLeadCard(c, o)
      const recorded = recordNotice(db, {
        kind: 'lead',
        title: `Заявка: ${c.title}`,
        body: [
          c.city,
          c.score ? `балл ${c.score.value}` : null,
          c.bidPriceRub > 0 ? `отклик ${c.bidPriceRub} ₽` : null,
          c.budgetText ? `бюджет ${c.budgetText}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        link: `/leads/${encodeURIComponent(c.orderId)}`,
        taskId: c.taskId,
        telegramMessageId: m.messageId,
      })
      await log(recorded, () => kindOf(recorded))
      return m
    },
    async sendText(text, o) {
      const m = await n.sendText(text, o)
      const recorded = noticeOfMessage(db, text, { hint: o?.notice, messageId: m.messageId })
      await log(recorded, () => kindOf(recorded))
      return m
    },
    async sendButtons(text, rows, o) {
      const m = await n.sendButtons(text, rows, o)
      const recorded = noticeOfMessage(db, text, { rows, hint: o?.notice, messageId: m.messageId })
      await log(recorded, () => kindOf(recorded))
      return m
    },
  }
}

/** Boris looked: the new ones are seen. */
export async function markSeen(db: DbOrTx, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db
    .update(notice)
    .set({ seenAt: new Date().toISOString() })
    .where(and(inArray(notice.id, ids), isNull(notice.seenAt)))
    .returning({ id: notice.id })
  return rows.length
}

/** «Убрать» on a notice that decides nothing by itself. */
export async function putAway(db: DbOrTx, id: string): Promise<boolean> {
  const rows = await db
    .update(notice)
    .set({ doneAt: new Date().toISOString(), seenAt: sql`coalesce(${notice.seenAt}, now())` })
    .where(and(eq(notice.id, id), isNull(notice.doneAt)))
    .returning({ id: notice.id })
  return rows.length > 0
}

/** The list for the bell: the last `limit`, newest first, with `done` read off the task or the question. */
export async function noticeList(
  db: DbOrTx,
  o: { state?: 'new' | 'open' | 'all'; limit?: number } = {},
): Promise<NoticeList> {
  const rows = await db
    .select({
      n: notice,
      taskResolvedAt: task.resolvedAt,
      taskState: task.state,
      questionAnsweredAt: question.answeredAt,
    })
    .from(notice)
    .leftJoin(task, eq(task.id, notice.taskId))
    .leftJoin(question, eq(question.id, notice.questionId))
    .orderBy(desc(notice.createdAt))
    .limit(o.limit ?? 200)
  const items: NoticeRow[] = rows.map(({ n, taskResolvedAt, taskState, questionAnsweredAt }) => {
    const doneAt =
      n.doneAt ??
      (taskState && taskState !== 'open' ? (taskResolvedAt ?? n.createdAt) : null) ??
      questionAnsweredAt ??
      null
    const state: NoticeRow['state'] = doneAt ? 'done' : n.seenAt ? 'seen' : 'new'
    return {
      id: n.id,
      kind: n.kind as NoticeRow['kind'],
      title: n.title,
      body: n.body,
      link: n.link,
      state,
      at: n.createdAt,
      seenAt: n.seenAt,
      doneAt,
      taskId: n.taskId,
      questionId: n.questionId,
    }
  })
  const unseen = items.filter((i) => i.state === 'new').length
  const picked =
    o.state === 'new'
      ? items.filter((i) => i.state === 'new')
      : o.state === 'open'
        ? items.filter((i) => i.state !== 'done')
        : items
  return { items: picked, unseen }
}
