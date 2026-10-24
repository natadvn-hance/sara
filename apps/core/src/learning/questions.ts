import { newEventId } from '@sara/shared'
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { leadLabel, question } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'

/** The «почему?» kinds, and edit_draft: Sara's request for a new bid text after «Изменить» (entity: the task). */
export type QuestionKind = 'why_skip' | 'why_want' | 'why_decline' | 'edit_draft'
export type QuestionRow = typeof question.$inferSelect
/** Boris's words that answer an edit_draft request. */
export type DraftAnswer = { question: QuestionRow; text: string; voice: boolean; at: Date }

const WHY_KINDS: QuestionKind[] = ['why_skip', 'why_want', 'why_decline']

/** At most this many «почему?» a Moscow day, so Sara never floods Boris with questions. */
export const QUESTIONS_PER_DAY = 3
/** A message without a reply answers the latest open question this recent. */
const ANSWER_WINDOW_MS = 30 * 60_000

const textOf = (kind: Exclude<QuestionKind, 'edit_draft'>, title: string) =>
  kind === 'why_skip'
    ? TEXTS.whySkip(title)
    : kind === 'why_want'
      ? TEXTS.whyWant(title)
      : TEXTS.whyDecline

/** Asks Boris why, unless today's questions are used up (then the surprise stays without a reason). */
export async function askWhy(
  d: { db: Db; notifier: Pick<Notifier, 'sendText'> },
  q: { kind: Exclude<QuestionKind, 'edit_draft'>; entityId: string; title: string },
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
 * After «Изменить»: asks for the new bid text. It is Boris's own request, so it never counts toward the day's
 * «почему?»; a reply to it (or the next message within 30 minutes) becomes the draft, not a reason.
 */
export async function askForDraft(
  d: { db: Db; notifier: Pick<Notifier, 'sendText'> },
  q: { taskId: string; title: string },
  now: Date,
): Promise<void> {
  const id = newEventId()
  await d.db
    .insert(question)
    .values({ id, kind: 'edit_draft', entityId: q.taskId, askedAt: now.toISOString() })
  await send(d, id, TEXTS.askDraft(q.title), { kind: 'edit_draft', entityId: q.taskId }, now)
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
 * Boris's words become the answer to a question: the one he replied to, or else the latest open one asked in
 * the last 30 minutes (and sent: a place taken for a question that never went out answers nothing). For a lead
 * the answer is also the reason on its label.
 */
export async function answerQuestion(
  db: Db,
  a: { text: string; replyToMessageId: number | null; voice: boolean; at: Date },
): Promise<{ question: QuestionRow } | null> {
  const q = await openQuestion(db, a)
  if (!q) return null
  const answered = await db.transaction((tx) => markAnswered(tx, q, a))
  return answered ? { question: { ...q, answeredAt: a.at.toISOString(), answer: a.text } } : null
}

/** The open question Boris's words answer: the one he replied to, or the latest sent in the last 30 minutes. */
export async function openQuestion(
  db: Db,
  a: { replyToMessageId: number | null; at: Date },
): Promise<QuestionRow | null> {
  const open = isNull(question.answeredAt)
  const [q] =
    a.replyToMessageId !== null
      ? await db
          .select()
          .from(question)
          .where(and(open, eq(question.telegramMessageId, a.replyToMessageId)))
      : await db
          .select()
          .from(question)
          .where(
            and(
              open,
              isNotNull(question.telegramMessageId),
              gte(question.askedAt, new Date(a.at.getTime() - ANSWER_WINDOW_MS).toISOString()),
            ),
          )
          .orderBy(desc(question.askedAt))
          .limit(1)
  return q ?? null
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
