import { newEventId } from '@sara/shared'
import { and, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { lead, leadLabel, lesson, lessonBatch, question, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'

/**
 * The «почему?» kinds, edit_draft: Sara's request for a new bid text after «Изменить», and edit_price: her request
 * for the «Стоимость услуги» after «Откликнуться» without one (entity: the task for both).
 */
export type QuestionKind =
  | 'why_skip'
  | 'why_want'
  | 'why_decline'
  | 'edit_draft'
  | 'edit_price'
  // M5: «почему нет?» after «нет» on a lesson (entity: the lesson)
  | 'why_lesson'
  // M5: the day's interview question (entity: the gap's key) and «что поправить?» on a record (entity: the lesson).
  | 'interview'
  | 'interview_fix'
export type QuestionRow = typeof question.$inferSelect
/** Boris's words that answer an edit_draft or edit_price request. */
export type DraftAnswer = { question: QuestionRow; text: string; voice: boolean; at: Date }

const WHY_KINDS: QuestionKind[] = ['why_skip', 'why_want', 'why_decline']
/** Sara's requests for the bid itself: an answer to one becomes the bid's text or price. */
export const DRAFT_KINDS: QuestionKind[] = ['edit_draft', 'edit_price']

/** At most this many «почему?» a Moscow day, so Sara never floods Boris with questions. */
export const QUESTIONS_PER_DAY = 3
/** A message without a reply may answer an open question this recent. */
const ANSWER_WINDOW_MS = 30 * 60_000

type WhyKind = 'why_skip' | 'why_want' | 'why_decline'

const textOf = (kind: WhyKind, title: string) =>
  kind === 'why_skip'
    ? TEXTS.whySkip(title)
    : kind === 'why_want'
      ? TEXTS.whyWant(title)
      : TEXTS.whyDecline

/** Asks Boris why, unless today's questions are used up (then the surprise stays without a reason). */
export async function askWhy(
  d: { db: Db; notifier: Pick<Notifier, 'sendText'> },
  q: { kind: WhyKind; entityId: string; title: string },
  now: Date,
): Promise<boolean> {
  const id = newEventId()
  // The day's place is taken under a lock before anything is sent: two surprises at once never make a 4th question.
  const reserved = await d.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('questions'))`)
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(question)
      .where(
        and(
          inArray(question.kind, WHY_KINDS),
          sql`(${question.askedAt} at time zone 'Europe/Moscow')::date = (${now.toISOString()}::timestamptz at time zone 'Europe/Moscow')::date`,
        ),
      )
    if (n >= QUESTIONS_PER_DAY) return false
    await tx
      .insert(question)
      .values({ id, kind: q.kind, entityId: q.entityId, askedAt: now.toISOString() })
    return true
  })
  if (!reserved) return false
  await send(d, id, textOf(q.kind, q.title), { kind: q.kind, entityId: q.entityId }, now)
  return true
}

/**
 * After «Изменить»: asks for the new bid text; after «Откликнуться» without the «Стоимость услуги»: for the price
 * (`price`). It is Boris's own request, so it never counts toward the day's «почему?»; a reply to it becomes the
 * draft, and so does a plain message when it is the only request waiting.
 */
export async function askForDraft(
  d: { db: Db; notifier: Pick<Notifier, 'sendText'> },
  q: { taskId: string; title: string },
  now: Date,
  what: 'text' | 'price' = 'text',
): Promise<void> {
  const id = newEventId()
  const kind = what === 'price' ? 'edit_price' : 'edit_draft'
  await d.db.insert(question).values({ id, kind, entityId: q.taskId, askedAt: now.toISOString() })
  const text = what === 'price' ? TEXTS.askPrice(q.title) : TEXTS.askDraft(q.title)
  await send(d, id, text, { kind, entityId: q.taskId }, now)
}

/**
 * A question that follows Boris's own press (M5: «почему нет?» after «нет» on a lesson): never counted toward the
 * day's «почему?», answered by a reply or by the next message within 30 minutes.
 */
export async function askOwnQuestion(
  d: { db: Db; notifier: Pick<Notifier, 'sendText'> },
  q: { kind: 'why_lesson' | 'interview' | 'interview_fix'; entityId: string; text: string },
  now: Date,
): Promise<void> {
  const id = newEventId()
  await d.db
    .insert(question)
    .values({ id, kind: q.kind, entityId: q.entityId, askedAt: now.toISOString() })
  await send(d, id, q.text, q, now)
}

/** Sends a question whose row is already taken; a send that fails removes the row, so it answers nothing. */
async function send(
  d: { db: Db; notifier: Pick<Notifier, 'sendText'> },
  id: string,
  text: string,
  q: { kind: QuestionKind; entityId: string },
  now: Date,
): Promise<void> {
  let m: { messageId: number }
  try {
    m = await d.notifier.sendText(text)
  } catch (e) {
    // Not asked: the row goes, so it takes no place of the day and answers nothing.
    await d.db.delete(question).where(eq(question.id, id))
    throw e
  }
  await d.db.update(question).set({ telegramMessageId: m.messageId }).where(eq(question.id, id))
  await appendEvent(d.db, {
    type: 'question.asked',
    v: 1,
    entity: { kind: 'question', id },
    account_id: null,
    actor: 'sara',
    occurred_at: now.toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { kind: q.kind, entity_id: q.entityId },
  })
}

/**
 * Boris's words become the answer to a «почему?»: the one he replied to, or else the latest open one asked in the
 * last 30 minutes (and sent: a place taken for a question that never went out answers nothing). For a lead the
 * answer is also the reason on its label. A request for a bid text is not a «почему?»: it takes its answer in
 * the inbox, never here.
 */
export async function answerQuestion(
  db: Db,
  a: { text: string; replyToMessageId: number | null; voice: boolean; at: Date },
): Promise<{ question: QuestionRow } | null> {
  const q = await openQuestion(db, a)
  if (!q || 'ambiguous' in q || q.kind === 'edit_draft') return null
  const answered = await db.transaction((tx) => markAnswered(tx, q, a))
  return answered ? { question: { ...q, answeredAt: a.at.toISOString(), answer: a.text } } : null
}

/** Several open questions fit a message without a reply, and none of them may take it on a guess. */
export type Ambiguous = { ambiguous: QuestionRow[] }

/**
 * The open question Boris's words answer: the one he replied to; or, without a reply, the latest «почему?» sent in
 * the last 30 minutes, or the request for a bid text when it is the only kind open and all of it is about one
 * lead. A text could be a new bid or a reason, so with both waiting (or edit requests for two leads) nothing is
 * guessed: the answer is `ambiguous` and Boris is asked to reply to the one he means.
 */
export async function openQuestion(
  db: Db,
  a: { replyToMessageId: number | null; at: Date },
): Promise<QuestionRow | Ambiguous | null> {
  const open = isNull(question.answeredAt)
  if (a.replyToMessageId !== null) {
    const [q] = await db
      .select()
      .from(question)
      .where(and(open, eq(question.telegramMessageId, a.replyToMessageId)))
    return q ?? null
  }
  // A request for a lead already decided has nothing left to take: it does not stand in the way.
  const stillWanted = or(
    notInArray(question.kind, DRAFT_KINDS),
    sql`exists (select 1 from ${task} where ${task.id}::text = ${question.entityId} and ${task.state} = 'open')`,
  )
  const recent = await db
    .select()
    .from(question)
    .where(
      and(
        open,
        isNotNull(question.telegramMessageId),
        gte(question.askedAt, new Date(a.at.getTime() - ANSWER_WINDOW_MS).toISOString()),
        stillWanted,
      ),
    )
    .orderBy(desc(question.askedAt))
  const edits = recent.filter((q) => (DRAFT_KINDS as string[]).includes(q.kind))
  const whys = recent.filter((q) => !(DRAFT_KINDS as string[]).includes(q.kind))
  if (edits.length === 0) {
    // «Почему нет?» on two lessons, the interview's question and a lead's «почему?», and the like: a plain answer is
    // never put on one of them by a guess. Lead «почему?» alone keep M2's rule (the latest takes it).
    const school = whys.some((q) => q.kind === 'why_lesson' || q.kind.startsWith('interview'))
    if (school && new Set(whys.map((q) => `${q.kind}:${q.entityId}`)).size > 1)
      return { ambiguous: [...whys].reverse() }
    return whys[0] ?? null
  }
  if (whys.length === 0 && new Set(edits.map((q) => q.entityId)).size === 1) return edits[0] ?? null
  return { ambiguous: recent.reverse() }
}

/**
 * What a question is about, for a note to Boris: the lead's title, «урок N» by the lesson's number in its batch (null
 * for the proposal's «почему?»).
 */
export async function titleOf(db: Db, q: QuestionRow): Promise<string | null> {
  if (q.kind === 'why_lesson') {
    const [b] = await db
      .select({ ids: lessonBatch.lessonIds })
      .from(lesson)
      .innerJoin(lessonBatch, eq(lessonBatch.id, lesson.batchId))
      .where(eq(lesson.id, q.entityId))
    const i = ((b?.ids as string[] | undefined) ?? []).indexOf(q.entityId) + 1
    return i > 0 ? `урок ${i}` : null
  }
  if (q.kind === 'why_decline' || q.kind.startsWith('interview')) return null
  const leadId = (DRAFT_KINDS as string[]).includes(q.kind)
    ? (await db.select({ id: task.entityId }).from(task).where(eq(task.id, q.entityId)))[0]?.id
    : q.entityId
  if (!leadId) return null
  const [l] = await db.select({ title: lead.title }).from(lead).where(eq(lead.id, leadId))
  return l?.title ?? null
}

/** Every open edit request of the task is closed: one answer takes them all, a later message lands on none. */
export async function closeDraftRequests(tx: DbOrTx, taskId: string, at: Date): Promise<void> {
  await tx
    .update(question)
    .set({ answeredAt: at.toISOString() })
    .where(
      and(
        inArray(question.kind, DRAFT_KINDS),
        eq(question.entityId, taskId),
        isNull(question.answeredAt),
      ),
    )
}

/** Marks the question answered once, inside the caller's transaction; false when it already was. */
export async function markAnswered(
  tx: DbOrTx,
  q: QuestionRow,
  a: { text: string; voice: boolean; at: Date },
): Promise<boolean> {
  const rows = await tx
    .update(question)
    .set({ answeredAt: a.at.toISOString(), answer: a.text })
    .where(and(eq(question.id, q.id), isNull(question.answeredAt)))
    .returning({ id: question.id })
  if (rows.length === 0) return false
  if (q.kind === 'why_skip' || q.kind === 'why_want') {
    await tx
      .update(leadLabel)
      .set({ reason: a.text, voice: a.voice })
      .where(eq(leadLabel.leadId, q.entityId))
  }
  if (q.kind === 'why_lesson')
    await tx.update(lesson).set({ reason: a.text }).where(eq(lesson.id, q.entityId))
  await appendEvent(tx, {
    type: 'question.answered',
    v: 1,
    entity: { kind: 'question', id: q.id },
    account_id: null,
    actor: 'boris',
    occurred_at: a.at.toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { kind: q.kind, voice: a.voice },
  })
  return true
}
