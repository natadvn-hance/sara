import { plural, shownTitle } from '@sara/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { convOwed, convTurn, jobRun, lead, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { mskParts } from '../learning/summary'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { getSetting } from '../settings/store'
import { NOT_TEST } from '../testLeads/sql'
import { rowsFor } from './cards'
import { CONV_TEXTS } from './texts'
import { moscowHour } from './time'
import { type StepDeps, topicStages, topicSteps } from './topicSteps'

/**
 * A client must not be left without an answer (Boris, 31.10: «вот тут не ответили клиенту, нельзя»). In drafts mode an
 * answer goes only on his «Отправить», so while the last word in a chat is the client's and nobody answered, Sara
 * reminds him in the client's topic: 30 minutes after the message, 2 hours after it, then every morning at 9:00
 * Moscow, until he sends, takes the client or closes the conversation. Each reminder replaces the one before it. Once a
 * day, and at once after a deploy, one summary of all the waiting clients goes to the general topic.
 */

const MIN = 60_000
const HOUR = 60 * MIN
/** The first two rungs of the ladder, from the client's message; after them it is every morning. */
const RUNGS = [30 * MIN, 2 * HOUR]
/** Chats whose last client word is older than this are history, not a waiting client. */
const MAX_AGE_DAYS = 14
/** At most this many reminders in one pass, so a deploy over many old chats does not flood Boris. */
const PER_PASS = 5
/** The morning of the daily summary and of the ladder's later steps, Moscow hours. */
const MORNING = 9

export type OwedDeps = {
  db: Db
  /** The order page, for the step «Заказ закрыт на сайте» (see topicSteps). */
  getOrder?: StepDeps['getOrder']
  notifier: Pick<
    Notifier,
    'sendText' | 'sendButtons' | 'markDone' | 'topicLink' | 'forumOn' | 'setTopicStage'
  >
}

type Waiting = {
  conversationId: string
  chatId: string
  orderId: string | null
  anchor: string
  words: string
  sentAt: Date
}

const failed = (what: string) => (e: unknown) =>
  console.error(`${what} failed`, e instanceof Error ? e.message : e)

/** The next 9:00 Moscow strictly after `t`. */
export function nextMorning(t: Date): Date {
  const shifted = new Date(t.getTime() + 3 * HOUR)
  let at = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), MORNING)
  if (at <= shifted.getTime()) at += 24 * HOUR
  return new Date(at - 3 * HOUR)
}

/** When the step after `steps` done is due; `lastAt` is when the last one went. */
export function owedDueAt(anchorAt: Date, steps: number, lastAt: Date | null): Date {
  const rung = RUNGS[steps]
  if (rung !== undefined) return new Date(anchorAt.getTime() + rung)
  return nextMorning(lastAt ?? new Date(anchorAt.getTime() + (RUNGS.at(-1) ?? 0)))
}

/** How many steps are done once one goes `now`: a rung already past is not sent again one minute later. */
export function stepsAfterSend(anchorAt: Date, steps: number, now: Date): number {
  const passed = RUNGS.filter((r) => anchorAt.getTime() + r <= now.getTime()).length
  return Math.max(steps + 1, passed)
}

/** «40 мин», «2 ч», «3 дн»: how long a client has waited. */
export function waitedText(ms: number): string {
  const min = Math.max(1, Math.round(ms / MIN))
  if (min < 60) return `${min} мин`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} ч`
  const days = Math.floor(h / 24)
  return `${days} ${plural(days, ['день', 'дня', 'дней'])}`
}

/** The chats where the last word is a client's and nobody answered: Boris's turn, in drafts mode. */
export async function waitingClients(d: { db: Db }, now: Date): Promise<Waiting[]> {
  const since = new Date(now.getTime() - MAX_AGE_DAYS * 24 * HOUR).toISOString()
  const res = await d.db.execute(sql`
    select c.id as conversation_id, c.chat_id, c.order_id, m.platform_message_id as anchor, m.text as words,
           m.sent_at as sent_at
    from core.conversation c
    join lateral (
      select * from core.chat_message m
      where m.conversation_id = c.id and m.side <> 'system'
      order by m.sent_at desc, m.platform_message_id desc
      limit 1
    ) m on true
    where c.closed_at is null and c.owner = 'sara' and m.side = 'client' and m.sent_at >= ${since}
      and ${NOT_TEST('c.chat_id')}
    order by m.sent_at asc`)
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    conversationId: String(r.conversation_id),
    chatId: String(r.chat_id),
    orderId: (r.order_id as string | null) ?? null,
    anchor: String(r.anchor),
    words: String(r.words ?? ''),
    sentAt: new Date(r.sent_at as string),
  }))
}

async function clientOf(db: Db, w: Waiting) {
  const [l] = w.orderId
    ? await db
        .select({ id: lead.id, name: lead.clientName, title: lead.title })
        .from(lead)
        .where(eq(lead.id, w.orderId))
    : []
  return { name: l?.name || null, order: l ? shownTitle(l.id, l.title) : null }
}

/** The draft waiting for Boris's «Отправить» for this client's last words, with the buttons it had. */
async function openDraft(db: Db, w: Waiting) {
  const turns = await db
    .select()
    .from(convTurn)
    .where(and(eq(convTurn.conversationId, w.conversationId), eq(convTurn.kind, 'reply')))
    .orderBy(sql`${convTurn.createdAt} desc`)
    .limit(1)
  const t = turns[0]
  if (!t?.taskId || !((t.messageIds as string[] | null) ?? []).includes(w.anchor)) return null
  const [k] = await db.select({ state: task.state }).from(task).where(eq(task.id, t.taskId))
  if (k?.state !== 'open') return null
  return { text: t.text, rows: rowsFor(t.taskId, t, false) }
}

async function journal(db: Db, type: 'conv.owed_reminded', conversationId: string, step: number) {
  await appendEvent(db, {
    type,
    v: 1,
    entity: { kind: 'conversation', id: conversationId },
    account_id: null,
    actor: 'system',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: conversationId,
    reason: null,
    payload: { step },
  })
}

/** One pass: the reminders that are due, the ones settled taken away, and the day's summary. */
export async function owedPass(d: OwedDeps, now: Date = new Date()): Promise<{ reminded: number }> {
  if (!(await getSetting(d.db, 'pipeline.conversations'))) return { reminded: 0 }
  // While old Sara still writes to clients (shadow) nothing is waiting for Boris.
  if (await getSetting(d.db, 'conv.v1_writes')) return { reminded: 0 }
  const waiting = await waitingClients(d, now)
  const ids = new Set(waiting.map((w) => w.conversationId))
  const rows = await d.db.select().from(convOwed)
  const byConv = new Map(rows.map((r) => [r.conversationId, r]))

  // Answered, taken or closed: the reminder in Telegram loses its buttons and the row goes.
  for (const r of rows) {
    if (ids.has(r.conversationId)) continue
    if (r.messageId !== null) await d.notifier.markDone?.(r.messageId, 'Решено').catch(() => {})
    await d.db.delete(convOwed).where(eq(convOwed.conversationId, r.conversationId))
  }

  let reminded = 0
  for (const w of waiting) {
    if (reminded >= PER_PASS) break
    let row = byConv.get(w.conversationId)
    // A new client message starts the ladder again.
    if (row && row.anchorMessageId !== w.anchor) {
      row = { ...row, anchorMessageId: w.anchor, steps: 0, lastAt: null }
    }
    const steps = row?.steps ?? 0
    const lastAt = row?.lastAt ? new Date(row.lastAt) : null
    if (owedDueAt(w.sentAt, steps, lastAt).getTime() > now.getTime()) {
      if (row && row !== byConv.get(w.conversationId))
        await d.db
          .update(convOwed)
          .set({ anchorMessageId: w.anchor, steps: 0, lastAt: null })
          .where(eq(convOwed.conversationId, w.conversationId))
      continue
    }
    const { name } = await clientOf(d.db, w)
    const draft = await openDraft(d.db, w)
    const text = CONV_TEXTS.owedReminder({
      name,
      waited: waitedText(now.getTime() - w.sentAt.getTime()),
      words: w.words,
      draft: draft?.text ?? null,
      canAnswer: draft !== null,
    })
    const place = { conversation: w.conversationId }
    const sent = draft
      ? await d.notifier.sendButtons(text, draft.rows, { html: true, place })
      : await d.notifier.sendText(text, { html: true, place })
    // The reminder before it gives way: one live reminder per client, not a pile.
    if (row?.messageId != null)
      await d.notifier.markDone?.(row.messageId, 'Новое напоминание ниже').catch(() => {})
    const after = stepsAfterSend(w.sentAt, steps, now)
    await d.db
      .insert(convOwed)
      .values({
        conversationId: w.conversationId,
        anchorMessageId: w.anchor,
        steps: after,
        lastAt: now.toISOString(),
        messageId: sent.messageId,
      })
      .onConflictDoUpdate({
        target: convOwed.conversationId,
        set: {
          anchorMessageId: w.anchor,
          steps: after,
          lastAt: now.toISOString(),
          messageId: sent.messageId,
        },
      })
    await journal(d.db, 'conv.owed_reminded', w.conversationId, after)
    reminded++
  }
  await topicStages(d).catch(failed('topic stages'))
  await topicSteps(d, now).catch(failed('topic steps'))
  await owedSummary(d, waiting, now)
  return { reminded }
}

/**
 * «Ждут твоего ответа: N»: once a Moscow day, from 9:00, and at once after a deploy (the first pass of a day it did
 * not yet run). A day with nobody waiting says nothing and takes the day anyway.
 */
export async function owedSummary(
  d: OwedDeps,
  waiting: Waiting[],
  now: Date,
): Promise<'not_yet' | 'already' | 'empty' | 'sent'> {
  if (moscowHour(now) < MORNING) return 'not_yet'
  const taken = await d.db
    .insert(jobRun)
    .values({ name: 'conv_owed_summary', day: mskParts(now).day })
    .onConflictDoNothing()
    .returning({ day: jobRun.day })
  if (taken.length === 0) return 'already'
  if (waiting.length === 0) return 'empty'
  const lines: {
    name: string | null
    order: string | null
    waited: string
    link: string | null
  }[] = []
  for (const w of waiting) {
    const c = await clientOf(d.db, w)
    lines.push({
      ...c,
      waited: waitedText(now.getTime() - w.sentAt.getTime()),
      link: (await d.notifier.topicLink?.({ conversation: w.conversationId })) ?? null,
    })
  }
  await d.notifier.sendText(CONV_TEXTS.owedSummary(lines), { html: true, place: 'general' })
  return 'sent'
}

export function startOwed(d: OwedDeps, tickMs = 60_000): { stop(): void } {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void owedPass(d)
      .catch((e) => console.error('owed reminders failed', e instanceof Error ? e.message : e))
      .finally(() => {
        running = false
      })
  }, tickMs)
  return { stop: () => clearInterval(timer) }
}
