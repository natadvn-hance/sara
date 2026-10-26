import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { task } from '../db/schema'
import type { ProfiClient } from '../profi/client'
import { deliverMessage, lastSeen, queueMessage } from './outbox'
import { settleReminder } from './reminderCard'
import type { Ground } from './reminderSteps'
import {
  SEND_TEXTS,
  type SendJob,
  type SendOptions,
  type SendOutcome,
  STALE_DRAFT,
} from './sendTexts'
import { getConversation } from './store'

/**
 * One send to a client in steps (FR-CONV-9): the reread of the chat of a reminder, the outbox, the delivery, and the
 * card and trace row it settles. The steps are the same whether they run one after the other (`runSendJob`, tests and
 * the autopilot) or as the durable process `convSend` (sendFlow.ts), which a press starts so the bot is never held.
 */
export type SendDeps = {
  db: Db
  profi: ProfiClient
  /** The chat read again before a reminder goes (reminders.ts): the last word on whether it is still wanted. */
  ground?(conversationId: string, anchor: string): Promise<Ground>
}

/** The job of a text: the last message it was written for, and a key; null when the conversation is gone. */
export async function prepareJob(
  d: { db: Db },
  conversationId: string,
  text: string,
  author: 'sara' | 'boris',
  o: SendOptions = {},
): Promise<SendJob | null> {
  const conv = await getConversation(d.db, conversationId)
  if (!conv) return null
  return {
    conversationId,
    text,
    author,
    key: o.key ?? `say:${newEventId()}`,
    expectLast: o.expectLast !== undefined ? o.expectLast : await lastSeen(d.db, conversationId),
    ...(o.after && { after: o.after }),
    ...(o.ground && { ground: o.ground }),
    ...(o.notBefore && { notBefore: o.notBefore }),
  }
}

/** Step: for a reminder the chat is read again; what it says decides whether the text goes and what it expects. */
export async function groundJob(
  d: SendDeps,
  job: SendJob,
): Promise<{ expectLast: string | null } | { outcome: SendOutcome }> {
  if (!job.ground) return { expectLast: job.expectLast }
  if (!d.ground) return { outcome: { kind: 'not_now', why: 'не могу проверить чат' } }
  const g = await d.ground(job.conversationId, job.ground.anchor)
  if (g.go) return { expectLast: g.lastId ?? job.expectLast }
  return { outcome: { kind: g.end ? 'gone' : 'not_now', why: g.why } }
}

/** Step: the text enters the outbox once per key; null when it may not go now (shadow, a pause, drafts mode). */
export async function queueJob(
  db: Db,
  job: SendJob,
  expectLast: string | null,
): Promise<string | null> {
  const conv = await getConversation(db, job.conversationId)
  if (!conv) return null
  return db.transaction((tx) =>
    queueMessage(tx, {
      key: job.key,
      accountId: conv.accountId,
      chatId: conv.chatId,
      text: job.text,
      author: job.author,
      expectLast,
    }),
  )
}

/** The text for Boris about a delivery. */
export const answerOf = (r: 'confirmed' | 'changed' | 'uncertain' | 'failed'): SendOutcome => ({
  kind: 'answer',
  answer: r === 'confirmed' ? SEND_TEXTS.sent : SEND_TEXTS[r],
})

/** Step: the card and the trace row the send came from are settled by how it ended; the text is for Boris. */
export async function settleJob(db: Db, job: SendJob, outcome: SendOutcome): Promise<string> {
  const a = job.after
  if (a?.kind === 'reminder') return settleReminder(db, a, outcome)
  if (outcome.kind !== 'answer')
    return outcome.kind === 'not_now' ? SEND_TEXTS.notNow : SEND_TEXTS.failed
  if (a?.kind === 'draft' && outcome.answer === SEND_TEXTS.changed) {
    await db.update(task).set({ resolution: 'stale' }).where(eq(task.id, a.taskId))
    return STALE_DRAFT
  }
  return outcome.answer
}

/** The whole send, step by step in this process: the text for Boris when it is over. */
export async function runSendJob(d: SendDeps, job: SendJob): Promise<string> {
  const g = await groundJob(d, job)
  if ('outcome' in g) return settleJob(d.db, job, g.outcome)
  const id = await queueJob(d.db, job, g.expectLast)
  if (!id) return settleJob(d.db, job, { kind: 'answer', answer: SEND_TEXTS.notNow })
  return settleJob(d.db, job, answerOf(await deliverMessage(d, id)))
}

/**
 * A text from Boris, or his «Отправить» on a draft, sent now after the switch; the answer is for Boris. Whole in this
 * process (tests, the autopilot); the bot uses `startSendJob`, which answers at once and tells him the result later.
 */
export async function sendTextNow(
  d: SendDeps,
  conversationId: string,
  text: string,
  author: 'sara' | 'boris',
  o: SendOptions = {},
): Promise<string> {
  const job = await prepareJob(d, conversationId, text, author, o)
  return job ? runSendJob(d, job) : SEND_TEXTS.failed
}
