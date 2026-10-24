import { newEventId } from '@sara/shared'
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { leadLabel, question } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'

export type QuestionKind = 'why_skip' | 'why_want' | 'why_decline'
export type QuestionRow = typeof question.$inferSelect

/** At most this many «почему?» a Moscow day, so Sara never floods Boris with questions. */
export const QUESTIONS_PER_DAY = 3
/** A message without a reply answers the latest open question this recent. */
const ANSWER_WINDOW_MS = 30 * 60_000

const textOf = (kind: QuestionKind, title: string) =>
  kind === 'why_skip'
    ? TEXTS.whySkip(title)
    : kind === 'why_want'
      ? TEXTS.whyWant(title)
      : TEXTS.whyDecline

/** Asks Boris why, unless today's questions are used up (then the surprise stays without a reason). */
export async function askWhy(
  d: { db: Db; notifier: Pick<Notifier, 'sendText'> },
  q: { kind: QuestionKind; entityId: string; title: string },
  now: Date,
): Promise<boolean> {
  const [{ n } = { n: 0 }] = await d.db
    .select({ n: sql<number>`count(*)::int` })
    .from(question)
    .where(
      sql`(${question.askedAt} at time zone 'Europe/Moscow')::date = (${now.toISOString()}::timestamptz at time zone 'Europe/Moscow')::date`,
    )
  if (n >= QUESTIONS_PER_DAY) return false
  const m = await d.notifier.sendText(textOf(q.kind, q.title))
  const id = newEventId()
  await d.db.insert(question).values({
    id,
    kind: q.kind,
    entityId: q.entityId,
    telegramMessageId: m.messageId,
    askedAt: now.toISOString(),
  })
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
  return true
}

/**
 * Boris's words become the answer to a question: the one he replied to, or else the latest open one asked in
 * the last 30 minutes. For a lead the answer is also the reason on its label.
 */
export async function answerQuestion(
  db: Db,
  a: { text: string; replyToMessageId: number | null; voice: boolean; at: Date },
): Promise<{ question: QuestionRow } | null> {
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
              gte(question.askedAt, new Date(a.at.getTime() - ANSWER_WINDOW_MS).toISOString()),
            ),
          )
          .orderBy(desc(question.askedAt))
          .limit(1)
  if (!q) return null
  const answered = await db.transaction(async (tx) => {
    const rows = await tx
      .update(question)
      .set({ answeredAt: a.at.toISOString(), answer: a.text })
      .where(and(eq(question.id, q.id), open))
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
  })
  return answered ? { question: { ...q, answeredAt: a.at.toISOString(), answer: a.text } } : null
}
