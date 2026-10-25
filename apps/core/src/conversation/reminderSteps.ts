import { type ChatMessage, formatCallback, newEventId, normalizeText } from '@sara/shared'
import { and, eq, gte, like, ne, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { account, chatMessage, convTurn, lead, outbox, task } from '../db/schema'
import { TransitionError, transition } from '../domain/deal'
import type { Gateway } from '../gateway/gateway'
import { appendEvent } from '../journal/journal'
import type { Notifier } from '../notify/notifier'
import type { ProfiClient } from '../profi/client'
import { getSetting } from '../settings/store'
import { clientNames } from './dossier'
import { deliverMessage, queueMessage } from './outbox'
import {
  nextReminder,
  type ReminderStep,
  type ReminderTone,
  reminderFallback,
} from './reminderLadder'
import { type TextStep, writeReminder } from './reminderText'
import { getConversation } from './store'
import { CONV_TEXTS } from './texts'
import type { ConversationRow, MindSearch, StoredMessage } from './types'

/** What the reminder process needs, set once at startup (the way the turn gets its dependencies). */
export type RemindDeps = {
  db: Db
  profi: ProfiClient
  gateway: Gateway
  mind: MindSearch
  notifier: Pick<Notifier, 'sendButtons'>
  /** M6: a conversation with a booked meeting gets no reminder. Not given: nothing is booked. */
  isBooked?(conversationId: string): Promise<boolean>
  /** How long after its time a reminder waits for the model before the ready text goes (default 3 hours). */
  fallbackAfterMs?: number
  /** How often a model that gave no text is asked again (default 10 minutes). */
  retryEveryMs?: number
  /** How long the task for Boris waits for his answer (default 30 days). */
  dormantWaitS?: number
  /** The least time between two reminders (default a day); tests shorten it. */
  minGapMs?: number
}

/** The step the ladder is at: when it is due, which reminder and in what tone. */
export type Planned = { at: string; step: ReminderStep; tone: ReminderTone }

export type Ground =
  | { go: true; read: boolean; lastId: string | null; shadow: boolean }
  /** `end`: the ladder is over for this conversation; otherwise only this step is skipped. */
  | { go: false; end: boolean; why: string }

export type Sent = {
  outcome: 'sent' | 'drafted' | 'skipped' | 'stopped' | 'failed' | 'uncertain'
  /** True when the ladder is over. */
  end: boolean
}

/** A turn that has not finished for longer than this is not running, it is stuck. */
const TURN_ALIVE_MS = 24 * 3600_000

const STOP = (why: string): Ground => ({ go: false, end: true, why })
const SKIP = (why: string): Ground => ({ go: false, end: false, why })

type Row = Partial<typeof convTurn.$inferInsert>

async function journal(
  db: DbOrTx,
  type: 'conv.reminder_drafted' | 'conv.reminder_sent' | 'conv.dormant',
  conv: ConversationRow,
  rowId: string,
  payload: Record<string, unknown>,
) {
  await appendEvent(db, {
    type,
    v: 1,
    entity: { kind: 'conv_turn', id: rowId },
    account_id: conv.accountId,
    actor: 'sara',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: conv.id,
    reason: null,
    // Numbers and labels only, never a client's words (ADR-022).
    payload: { conversation_id: conv.id, ...payload },
  })
}

/** Whether the trace row already ended with this outcome: a repeat of a step after a crash must not journal twice. */
async function endedWith(d: RemindDeps, rowId: string, outcome: string): Promise<boolean> {
  const [r] = await d.db
    .select({ outcome: convTurn.outcome })
    .from(convTurn)
    .where(eq(convTurn.id, rowId))
  return r?.outcome === outcome
}

async function finishRow(db: DbOrTx, rowId: string, patch: Row) {
  const now = new Date().toISOString()
  await db
    .update(convTurn)
    .set({
      ...patch,
      state: 'finished',
      finishedAt: now,
      timings: sql`${convTurn.timings} || ${JSON.stringify({ finished: now })}::jsonb`,
    })
    .where(eq(convTurn.id, rowId))
}

/** The trace row of one reminder step, once (its id is the process id and the step). */
async function ensureRow(
  d: RemindDeps,
  rowId: string,
  conversationId: string,
  anchor: string,
  p: Planned,
) {
  const now = new Date().toISOString()
  await d.db
    .insert(convTurn)
    .values({
      id: rowId,
      conversationId,
      kind: 'reminder',
      anchorMessageId: anchor,
      state: 'waiting',
      understanding: { step: p.step, tone: p.tone },
      timings: { started: now },
    })
    .onConflictDoNothing()
}

/** The step the ladder is at, from our message the client did not answer and what has been done (design 5.11). */
export async function planNext(
  d: RemindDeps,
  conversationId: string,
  anchor: string,
  st: { sent: number; continued: boolean; lastSentAt: string | null },
): Promise<Planned | null> {
  const conv = await getConversation(d.db, conversationId)
  if (!conv) return null
  const [m] = await d.db
    .select()
    .from(chatMessage)
    .where(
      and(eq(chatMessage.accountId, conv.accountId), eq(chatMessage.platformMessageId, anchor)),
    )
  if (!m) return null
  const r = nextReminder({
    lastOursAt: m.sentAt,
    sent: st.sent,
    read: m.read,
    continued: st.continued,
    now: new Date(),
    lastSentAt: st.lastSentAt,
    quiet: await getSetting(d.db, 'conv.reminder_quiet'),
    minGapMs: d.minGapMs,
  })
  return r ? { at: r.at.toISOString(), step: r.step, tone: r.tone } : null
}

/** The texts of the reminders this conversation's ladder sent: they stand in the chat as our side's messages. */
export async function ladderTexts(db: Db, conversationId: string): Promise<Set<string>> {
  const rows = await db
    .select({ payload: outbox.payload })
    .from(outbox)
    .where(
      and(
        eq(outbox.kind, 'message'),
        like(outbox.idempotencyKey, `msg:conv-remind:${conversationId}:%`),
      ),
    )
  return new Set(rows.map((r) => normalizeText((r.payload as { text?: string }).text ?? '')))
}

/** One of the ladder's own reminders, which the sync stored as Sara's from the outbox. */
export const isLadderMessage = (m: Pick<StoredMessage, 'author' | 'text'>, texts: Set<string>) =>
  m.author === 'sara' && texts.has(normalizeText(m.text))

/**
 * Whether a reminder may go now: the last word before it is spoken, at the wake-up and again right before sending
 * (FR-CONV-12, FR-CONV-6). Nothing goes for a conversation that is closed, Boris's or booked, to a client who wrote
 * or when our side wrote since the anchor, while a turn runs, and (after the switch) while the «Пишет клиентам»
 * pause or the account's pause holds. The chat is read again here; an unreadable chat skips the step.
 */
export async function checkGround(
  d: RemindDeps,
  conversationId: string,
  anchor: string,
  o: { dormant: boolean },
): Promise<Ground> {
  const { db } = d
  const conv = await getConversation(db, conversationId)
  if (!conv) return STOP('разговора нет')
  if (!(await getSetting(db, 'pipeline.conversations'))) return STOP('разговоры выключены')
  if (!(await getSetting(db, 'conv.reminders'))) return STOP('напоминания выключены')
  if (conv.closedAt) return STOP('разговор закрыт')
  if (conv.owner !== 'sara') return STOP('клиента ведёт Борис')
  try {
    if (await d.isBooked?.(conv.id)) return STOP('назначена встреча')
  } catch (e) {
    console.error('reminder: booking not known', e instanceof Error ? e.message : e)
    return SKIP('не смогла узнать про встречу')
  }
  const v1Writes = await getSetting(db, 'conv.v1_writes')
  // The chat is only read here, never stored: a message nobody has heard of yet reaches the conversation through its
  // own event or the 10-minute check, which also start the turn it needs. A reminder must not swallow a client's word.
  let chat: ChatMessage[]
  try {
    chat = (await d.profi.readChat(conv.accountId, conv.chatId)).messages
  } catch (e) {
    console.error('reminder: chat unreadable', e instanceof Error ? e.message : e)
    return SKIP('не могу прочитать чат')
  }
  const at = chat.findIndex((m) => m.platform_message_id === anchor)
  if (at < 0) return STOP('нашего сообщения нет в чате')
  const after = chat.slice(at + 1)
  if (after.some((m) => m.author === 'client')) return STOP('клиент ответил')
  if (after.some((m) => m.author === 'unknown')) return STOP('автор сообщения неясен')
  // The ladder's own earlier reminders stand after the anchor too; anything else of our side is a new beginning.
  const ladder = await ladderTexts(db, conv.id)
  if (after.some((m) => m.author === 'specialist' && !ladder.has(normalizeText(m.text))))
    return STOP('наша сторона уже написала')
  const [running] = await db
    .select({ id: convTurn.id })
    .from(convTurn)
    .where(
      and(
        eq(convTurn.conversationId, conv.id),
        eq(convTurn.kind, 'reply'),
        ne(convTurn.state, 'finished'),
        gte(convTurn.createdAt, new Date(Date.now() - TURN_ALIVE_MS).toISOString()),
      ),
    )
    .limit(1)
  if (running) return SKIP('идёт ход разговора')
  if (!o.dormant && !v1Writes) {
    const [a] = await db.select().from(account).where(eq(account.id, conv.accountId))
    if (a && (a.paused || a.loginState === 'dead' || a.loginState === 'banned'))
      return SKIP('аккаунт на паузе')
    if (!(await getSetting(db, 'outbound.messages'))) return SKIP('пауза «Пишет клиентам»')
  }
  // «Прочитал» is the stored mark of our last message, which only the client's read event sets (design 5.11).
  const lastOurs = chat.findLast((m) => m.author === 'specialist')
  const [stored] = lastOurs
    ? await db
        .select({ read: chatMessage.read })
        .from(chatMessage)
        .where(
          and(
            eq(chatMessage.accountId, conv.accountId),
            eq(chatMessage.platformMessageId, lastOurs.platform_message_id),
          ),
        )
    : []
  return {
    go: true,
    read: stored?.read ?? false,
    lastId: chat.at(-1)?.platform_message_id ?? null,
    shadow: v1Writes,
  }
}

/** The wake-up of a step: its trace row, and the check; a step that may not go is closed in the trace. */
export async function groundStep(
  d: RemindDeps,
  rowId: string,
  conversationId: string,
  anchor: string,
  p: Planned,
): Promise<Ground> {
  await ensureRow(d, rowId, conversationId, anchor, p)
  const g = await checkGround(d, conversationId, anchor, { dormant: p.step === 'dormant' })
  if (g.go) {
    await d.db
      .update(convTurn)
      .set({ understanding: { step: p.step, tone: p.tone, read: g.read } })
      .where(eq(convTurn.id, rowId))
    return g
  }
  await finishRow(d.db, rowId, {
    outcome: g.end ? 'stopped' : 'skipped',
    decision: 'nothing',
    decisionReason: g.why,
  })
  return g
}

/** The model's try at the text, in one step so a replay does not ask it again. Never throws: no text is the answer. */
export async function writeStep(
  d: RemindDeps,
  rowId: string,
  conversationId: string,
  p: Planned,
  read: boolean,
  limitMs: number,
): Promise<{ text: string | null }> {
  try {
    const w = await writeReminder(
      { db: d.db, gateway: d.gateway, mind: d.mind, profi: d.profi },
      {
        conversationId,
        step: p.step as TextStep,
        tone: p.tone,
        read,
        now: new Date(),
        limitWaitMs: Math.max(0, limitMs),
      },
    )
    const [prev] = await d.db
      .select({ ids: convTurn.modelCallIds })
      .from(convTurn)
      .where(eq(convTurn.id, rowId))
    await d.db
      .update(convTurn)
      .set({
        move: 'reply',
        mindVersion: w.mindVersion,
        recalled: { ids: w.recalled },
        text: w.text,
        factIds: w.factIds,
        modelCallIds: [...((prev?.ids as string[] | undefined) ?? []), ...w.modelCallIds],
        checks: { issues: w.issues, attempts: w.attempts, failure: w.failure, fallback: false },
      })
      .where(eq(convTurn.id, rowId))
    return { text: w.text }
  } catch (e) {
    console.error('reminder: the text was not written', e instanceof Error ? e.message : e)
    return { text: null }
  }
}

/** No text from the model in time: the ready text of old Sara goes (it was approved by Boris long ago). */
export async function fallbackStep(
  d: RemindDeps,
  rowId: string,
  conversationId: string,
  p: Planned,
): Promise<{ text: string }> {
  const conv = await getConversation(d.db, conversationId)
  const names = conv ? await clientNames(d.db, conv) : []
  const text = reminderFallback(names[0] ?? null, p.tone)
  await d.db
    .update(convTurn)
    .set({
      text,
      checks: sql`coalesce(${convTurn.checks}, '{}'::jsonb) || ${JSON.stringify({ fallback: true })}::jsonb`,
    })
    .where(eq(convTurn.id, rowId))
  return { text }
}

/** The outbox row of a reminder is delivered, and the trace says how it went. */
async function deliver(
  d: RemindDeps,
  rowId: string,
  conv: ConversationRow,
  outboxId: string,
  p: Planned,
): Promise<Sent> {
  const r = await deliverMessage({ db: d.db, profi: d.profi }, outboxId)
  if (r === 'confirmed') {
    if (!(await endedWith(d, rowId, 'sent')))
      // The row ends together with its event: whoever sees the one sees the other.
      await d.db.transaction(async (tx) => {
        await finishRow(tx, rowId, {
          outcome: 'sent',
          decision: 'send',
          decisionReason: 'ушло клиенту',
        })
        await journal(tx, 'conv.reminder_sent', conv, rowId, { step: p.step })
      })
    return { outcome: 'sent', end: false }
  }
  if (r === 'changed') {
    await finishRow(d.db, rowId, {
      outcome: 'stopped',
      decision: 'nothing',
      decisionReason: 'в чате появилось новое: служба не дала написать',
    })
    return { outcome: 'stopped', end: true }
  }
  const uncertain = r === 'uncertain'
  await finishRow(d.db, rowId, {
    outcome: uncertain ? 'uncertain' : 'failed',
    decision: 'send',
    decisionReason: uncertain ? 'не уверена, что дошло' : 'не смогла отправить',
  })
  return { outcome: uncertain ? 'uncertain' : 'failed', end: false }
}

/**
 * The end of a reminder step: the last check, then the shadow's record or the send through the message outbox. In
 * shadow nothing is queued, the draft is only the trace (design 5.11). The key is the process and the step, so a
 * repeat of this step after a crash sends the same message once, and the chat is not asked again.
 */
export async function sendStep(
  d: RemindDeps,
  rowId: string,
  conversationId: string,
  anchor: string,
  p: Planned,
  text: string,
): Promise<Sent> {
  const conv = await getConversation(d.db, conversationId)
  if (!conv) return { outcome: 'stopped', end: true }
  const [queued] = await d.db
    .select({ id: outbox.id })
    .from(outbox)
    .where(eq(outbox.idempotencyKey, `msg:${rowId}`))
  if (queued) return deliver(d, rowId, conv, queued.id, p)
  const g = await checkGround(d, conversationId, anchor, { dormant: false })
  if (!g.go) {
    await finishRow(d.db, rowId, {
      outcome: g.end ? 'stopped' : 'skipped',
      decision: 'nothing',
      decisionReason: g.why,
    })
    return { outcome: g.end ? 'stopped' : 'skipped', end: g.end }
  }
  if (g.shadow) {
    if (!(await endedWith(d, rowId, 'drafted')))
      await d.db.transaction(async (tx) => {
        await finishRow(tx, rowId, {
          outcome: 'drafted',
          decision: 'draft',
          decisionReason: 'режим тени: клиенту ничего не ушло',
        })
        await journal(tx, 'conv.reminder_drafted', conv, rowId, { step: p.step })
      })
    return { outcome: 'drafted', end: false }
  }
  const id = await d.db.transaction((tx) =>
    queueMessage(tx, {
      key: rowId,
      accountId: conv.accountId,
      chatId: conv.chatId,
      text,
      author: 'sara',
      expectLast: g.lastId,
    }),
  )
  if (!id) {
    await finishRow(d.db, rowId, {
      outcome: 'skipped',
      decision: 'nothing',
      decisionReason: 'сейчас не отправляю: пауза или режим тени',
    })
    return { outcome: 'skipped', end: false }
  }
  return deliver(d, rowId, conv, id, p)
}

/**
 * The seventh day: the client is dormant. In shadow only the trace says so. After the switch the deal, if there is
 * one, becomes dormant and Boris gets one task with «Закрыть» and «Напоминать дальше» (design 5.11).
 */
export async function dormantStep(
  d: RemindDeps,
  rowId: string,
  conversationId: string,
  shadow: boolean,
): Promise<{ asked: boolean }> {
  const conv = await getConversation(d.db, conversationId)
  if (!conv) return { asked: false }
  // The step ends when its work is done, so a row that is finished has its task too.
  const settle = async () => {
    if (await endedWith(d, rowId, 'dormant')) return
    await d.db.transaction(async (tx) => {
      await finishRow(tx, rowId, {
        outcome: 'dormant',
        decision: shadow ? 'trace' : 'task',
        decisionReason: shadow ? 'в тени задача Борису только в трассе' : 'клиент молчит 7 дней',
      })
      await journal(tx, 'conv.dormant', conv, rowId, { shadow })
    })
  }
  if (shadow) {
    await settle()
    return { asked: false }
  }
  if (conv.dealId)
    try {
      await transition(d.db, {
        dealId: conv.dealId,
        to: 'dormant',
        actor: 'sara',
        reason: 'клиент молчит 7 дней',
        correlationId: conv.id,
      })
    } catch (e) {
      // Already dormant, or a stage that cannot become dormant (a booked meeting): the task still goes.
      if (!(e instanceof TransitionError)) throw e
    }
  const [have] = await d.db
    .select({ id: task.id })
    .from(task)
    .where(and(eq(task.kind, 'conv_dormant'), eq(task.entityId, rowId)))
  if (have) {
    await settle()
    return { asked: true }
  }
  const [l] = conv.orderId ? await d.db.select().from(lead).where(eq(lead.id, conv.orderId)) : []
  const [sent] = await d.db
    .select({ n: sql<number>`count(*)::int` })
    .from(convTurn)
    .where(
      and(
        eq(convTurn.conversationId, conv.id),
        eq(convTurn.kind, 'reminder'),
        eq(convTurn.outcome, 'sent'),
      ),
    )
  const taskId = newEventId()
  const button = (text: string, action: 'close' | 'remind') => ({
    text,
    callbackData: formatCallback(taskId, action),
  })
  const m = await d.notifier.sendButtons(
    CONV_TEXTS.dormant(l?.clientName || null, l?.title ?? null, sent?.n ?? 0),
    [[button(CONV_TEXTS.buttons.close, 'close'), button(CONV_TEXTS.buttons.remind, 'remind')]],
  )
  await d.db.transaction(async (tx) => {
    await tx.insert(task).values({
      id: taskId,
      kind: 'conv_dormant',
      entityKind: 'conv_turn',
      entityId: rowId,
      priority: 'P1',
      telegramMessageId: m.messageId,
    })
    await tx
      .update(convTurn)
      .set({ taskId, cardMessageId: m.messageId })
      .where(eq(convTurn.id, rowId))
    await appendEvent(tx, {
      type: 'task.created',
      v: 1,
      entity: { kind: 'task', id: taskId },
      account_id: null,
      actor: 'sara',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: conv.id,
      reason: null,
      payload: { kind: 'conv_dormant', turn_id: rowId },
    })
  })
  await settle()
  return { asked: true }
}
