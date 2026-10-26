import { type ChatMessage, formatCallback, newEventId, normalizeText } from '@sara/shared'
import { and, asc, desc, eq, gte, isNotNull, like, ne, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { account, chatMessage, convTurn, lead, outbox, task } from '../db/schema'
import { TransitionError, transition } from '../domain/deal'
import type { Gateway } from '../gateway/gateway'
import { appendEvent } from '../journal/journal'
import type { Notifier } from '../notify/notifier'
import type { ProfiClient } from '../profi/client'
import { getSetting } from '../settings/store'
import { clientTurnBefore, isRefusal, isThinking } from './clientCues'
import { clientNames } from './dossier'
import { deliverMessage, queueMessage } from './outbox'
import { expireOldCards, sendReminderCard } from './reminderCard'
import {
  nextReminder,
  type ReminderStep,
  type ReminderTone,
  reminderFallback,
  type Waits,
} from './reminderLadder'
import { type TextStep, writeReminder } from './reminderText'
import { getConversation } from './store'
import { CONV_TEXTS } from './texts'
import { moscowHoursEnd } from './time'
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
  /** The waits after the first reminder (2, 3 and 3 days, each from the step before); tests shorten them. */
  waitsMs?: Waits
  /** The least time between two reminders that really went out (default a day); tests shorten it. */
  minGapMs?: number
  /** How often the silence task is tried again while something stands in its way (default an hour). */
  dormantRetryEveryMs?: number
  /** How often it is tried again after a failure, a Telegram outage say (default 10 minutes). */
  dormantStepRetryMs?: number
  /** How many tries the silence task gets before it is given up (default 24, a day). */
  dormantTries?: number
  /** How often a card that Telegram would not take is tried again (default 10 minutes), and how many tries (6). */
  cardRetryEveryMs?: number
  cardTries?: number
}

/** The step the ladder is at: when it is due, which reminder and in what tone. */
export type Planned = { at: string; step: ReminderStep; tone: ReminderTone }

export type Ground =
  | { go: true; read: boolean; lastId: string | null; shadow: boolean }
  /** `end`: the ladder is over for this conversation; otherwise only this step is skipped. */
  | { go: false; end: boolean; why: string }

export type Sent = {
  /** `carded`: drafts mode, Boris has the card «Напомнить клиенту?» and nothing is queued. */
  outcome: 'sent' | 'drafted' | 'carded' | 'skipped' | 'stopped' | 'failed' | 'uncertain'
  /** True when the ladder is over. */
  end: boolean
  /** The card did not reach Boris (Telegram is down): the row stays open and the step is tried again. */
  retry?: boolean
}

/** A turn that has not finished for longer than this is not running, it is stuck. */
const TURN_ALIVE_MS = 24 * 3600_000

/** The first reminder of a client who went to think it over waits this long after our message. */
const THINKING_FIRST_MS = 48 * 3600_000

/** Why the ladder of a client who said no is not run (the trace says it). */
export const REFUSED = 'клиент отказался'

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
  st: {
    /** How many steps of the ladder are done. */
    sent: number
    /** When the step before went, or was due if it was only skipped: the next wait counts from there. */
    prevAt: string | null
  },
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
  // «Я подумаю»: a client who went to think it over gets two days before the first reminder, not one.
  const stored = await d.db
    .select({ id: chatMessage.platformMessageId, side: chatMessage.side, text: chatMessage.text })
    .from(chatMessage)
    .where(eq(chatMessage.conversationId, conversationId))
    .orderBy(asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))
  const thinking = isThinking(clientTurnBefore(stored, anchor))
  const r = nextReminder({
    lastOursAt: m.sentAt,
    sent: st.sent,
    read: m.read,
    now: new Date(),
    prevAt: st.prevAt,
    quiet: await getSetting(d.db, 'conv.reminder_quiet'),
    waitsMs: d.waitsMs,
    ...(thinking && { firstAfterMs: THINKING_FIRST_MS }),
  })
  return r ? { at: r.at.toISOString(), step: r.step, tone: r.tone } : null
}

/**
 * The reminders this conversation's ladder sent, as the chat shows them: they stand there as our side's messages. Those
 * that went by themselves (the key of their process), those Boris sent with «Отправить» on the card of a reminder (the
 * key of the card's task) and his own version of a reminder (what he wrote after «Изменить»). `confirmedAt` is when the
 * service confirmed the message; null for a text that is only known as his version.
 */
async function ladderRows(
  db: Db,
  conversationId: string,
): Promise<{ text: string; confirmedAt: string | null }[]> {
  const own = await db
    .select({ payload: outbox.payload, confirmedAt: outbox.confirmedAt })
    .from(outbox)
    .where(
      and(
        eq(outbox.kind, 'message'),
        like(outbox.idempotencyKey, `msg:conv-remind:${conversationId}:%`),
      ),
    )
  const pressed = await db
    .select({ payload: outbox.payload, confirmedAt: outbox.confirmedAt })
    .from(outbox)
    .innerJoin(task, eq(outbox.idempotencyKey, sql`'msg:send:' || ${task.id}::text`))
    .where(and(eq(outbox.kind, 'message'), like(task.entityId, `conv-remind:${conversationId}:%`)))
  const edited = await db
    .select({ text: convTurn.borisText })
    .from(convTurn)
    .where(
      and(
        eq(convTurn.conversationId, conversationId),
        eq(convTurn.kind, 'reminder'),
        isNotNull(convTurn.borisText),
      ),
    )
  const editedTexts = new Set(edited.map((r) => normalizeText(r.text ?? '')))
  const conv = await getConversation(db, conversationId)
  // His version went through the outbox under his own key: it is found by its text in this chat.
  const sentEdited =
    conv && editedTexts.size > 0
      ? (
          await db
            .select({ payload: outbox.payload, confirmedAt: outbox.confirmedAt })
            .from(outbox)
            .where(
              and(eq(outbox.kind, 'message'), sql`${outbox.payload}->>'chatId' = ${conv.chatId}`),
            )
        ).filter((r) => editedTexts.has(normalizeText((r.payload as { text?: string }).text ?? '')))
      : []
  return [
    ...[...own, ...pressed, ...sentEdited].map((r) => ({
      text: normalizeText((r.payload as { text?: string }).text ?? ''),
      confirmedAt: r.confirmedAt,
    })),
    ...edited.map((r) => ({ text: normalizeText(r.text ?? ''), confirmedAt: null })),
  ]
}

/** The texts of the reminders this conversation's ladder sent: they stand in the chat as our side's messages. */
export async function ladderTexts(db: Db, conversationId: string): Promise<Set<string>> {
  return new Set((await ladderRows(db, conversationId)).map((r) => r.text))
}

/** When the last reminder of the ladder really went out (the service confirmed it), or null if none did. */
export async function lastReminderWentAt(db: Db, conversationId: string): Promise<number | null> {
  const times = (await ladderRows(db, conversationId))
    .map((r) => (r.confirmedAt ? Date.parse(r.confirmedAt) : Number.NaN))
    .filter((t) => !Number.isNaN(t))
  return times.length > 0 ? Math.max(...times) : null
}

/**
 * One of the ladder's own reminders, which the sync stored as Sara's from the outbox (or as Boris's own words when he
 * changed the text of a reminder card).
 */
export const isLadderMessage = (
  m: Pick<StoredMessage, 'author' | 'authorBasis' | 'text'>,
  texts: Set<string>,
) =>
  (m.author === 'sara' || (m.author === 'boris' && m.authorBasis === 'say')) &&
  texts.has(normalizeText(m.text))

/** The account is paused, logged out or banned: nothing is written to its clients. */
async function accountHolds(db: Db, accountId: string): Promise<boolean> {
  const [a] = await db.select().from(account).where(eq(account.id, accountId))
  return a ? a.paused || a.loginState === 'dead' || a.loginState === 'banned' : false
}

/**
 * The chat as the client's side of the check: nobody wrote after our message (the ladder's own earlier reminders
 * aside), and what the stored marks say about our last message. The chat is only read, never stored: a message nobody
 * has heard of yet reaches the conversation through its own event or the 10-minute check, which also start the turn
 * it needs. A reminder must not swallow a client's word.
 */
async function readGround(
  d: RemindDeps,
  conv: ConversationRow,
  anchor: string,
): Promise<{ read: boolean; lastId: string | null } | Ground> {
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
  const ladder = await ladderTexts(d.db, conv.id)
  if (after.some((m) => m.author === 'specialist' && !ladder.has(normalizeText(m.text))))
    return STOP('наша сторона уже написала')
  // The client said no before our last message: our polite answer to it is not a reason to write to him again.
  const turn = clientTurnBefore(
    chat.map((m) => ({ id: m.platform_message_id, side: m.author, text: m.text })),
    anchor,
  )
  if (isRefusal(turn)) return STOP(REFUSED)
  // «Прочитал» is the stored mark of our last message, which only the client's read event sets (design 5.11).
  const lastOurs = chat.findLast((m) => m.author === 'specialist')
  const [stored] = lastOurs
    ? await d.db
        .select({ read: chatMessage.read })
        .from(chatMessage)
        .where(
          and(
            eq(chatMessage.accountId, conv.accountId),
            eq(chatMessage.platformMessageId, lastOurs.platform_message_id),
          ),
        )
    : []
  return { read: stored?.read ?? false, lastId: chat.at(-1)?.platform_message_id ?? null }
}

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
  // A switch turned off skips the step but does not end the process: it goes on when the switch is back on.
  if (!(await getSetting(db, 'pipeline.conversations'))) return SKIP('разговоры выключены')
  if (!(await getSetting(db, 'conv.reminders'))) return SKIP('напоминания выключены')
  if (conv.closedAt) return STOP('разговор закрыт')
  if (conv.owner !== 'sara') return STOP('клиента ведёт Борис')
  try {
    if (await d.isBooked?.(conv.id)) return STOP('назначена встреча')
  } catch (e) {
    console.error('reminder: booking not known', e instanceof Error ? e.message : e)
    return SKIP('не смогла узнать про встречу')
  }
  const v1Writes = await getSetting(db, 'conv.v1_writes')
  // The dormant day is a task for Boris, not a message to the client: the chat is not read for it (a client who wrote
  // meanwhile cancels the process through his own event).
  const seen = o.dormant
    ? { read: false, lastId: null as string | null }
    : await readGround(d, conv, anchor)
  if ('go' in seen) return seen
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
    if (await accountHolds(db, conv.accountId)) return SKIP('аккаунт на паузе')
    if (!(await getSetting(db, 'outbound.messages'))) return SKIP('пауза «Пишет клиентам»')
  }
  return { go: true, read: seen.read, lastId: seen.lastId, shadow: v1Writes }
}

/** The wake-up of a step: its trace row, and the check; a step that may not go is closed in the trace. */
export async function groundStep(
  d: RemindDeps,
  rowId: string,
  conversationId: string,
  anchor: string,
  p: Planned,
  /** `retry`: a skip leaves the row open, the caller will try again and closes the row itself in the end. */
  o: { retry?: boolean } = {},
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
  if (!g.end && o.retry) return g
  await finishRow(d.db, rowId, {
    outcome: g.end ? 'stopped' : 'skipped',
    decision: 'nothing',
    decisionReason: g.why,
  })
  return g
}

/** The silence task could not be told to Boris in the whole time it was tried: the row says why. */
export async function giveUpDormant(d: RemindDeps, rowId: string, why: string): Promise<void> {
  await finishRow(d.db, rowId, {
    outcome: 'skipped',
    decision: 'nothing',
    decisionReason: `не смогла сообщить Борису: ${why}`,
  })
}

/** The least time between two reminders that really went out: a late press never puts two close together. */
const MIN_GAP_MS = 24 * 3600_000

/**
 * How long a reminder still waits right before it goes, or null if it may go now. The planned time was outside the
 * quiet hours (`conv.reminder_quiet`), but getting the text can take hours (a limit wait, a rewrite, the ready text),
 * so a reminder due at 22:30 could be sent at 01:30: the time is looked at again here. And a day must have passed
 * since the last reminder that really went out (Boris may have pressed a card late, after the wait of the next step
 * was already running), so two reminders never reach a client 2 hours apart.
 */
export async function quietUntil(
  d: RemindDeps,
  now: Date,
  conversationId: string,
): Promise<{ until: string | null }> {
  const went = await lastReminderWentAt(d.db, conversationId)
  const gapEnd = went === null ? 0 : went + (d.minGapMs ?? MIN_GAP_MS)
  const at = new Date(Math.max(now.getTime(), gapEnd))
  const end = moscowHoursEnd(at, await getSetting(d.db, 'conv.reminder_quiet'))
  const until = end ?? (at.getTime() > now.getTime() ? at : null)
  return { until: until ? until.toISOString() : null }
}

/** The model's try at the text, in one step so a replay does not ask it again. Never throws: no text is the answer. */
export async function writeStep(
  d: RemindDeps,
  rowId: string,
  conversationId: string,
  p: Planned,
  read: boolean,
  limitMs: number,
): Promise<{ text: string | null; modelFailed: boolean }> {
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
    // A model that gave no answer is asked again later; one whose text failed the checks twice is not, the ready
    // text goes at once (the same model, asked again and again, would only spend the subscription).
    return { text: w.text, modelFailed: w.text === null && w.failure !== null }
  } catch (e) {
    console.error('reminder: the text was not written', e instanceof Error ? e.message : e)
    return { text: null, modelFailed: true }
  }
}

/**
 * No text from the model that passes the checks: the ready text of old Sara goes (Boris approved it long ago). Of its
 * two wordings the one our side has not sent to this client yet is taken, so the second reminder never repeats the
 * first word for word; when both were sent, the one that is not the last message of ours.
 */
export async function fallbackStep(
  d: RemindDeps,
  rowId: string,
  conversationId: string,
  p: Planned,
): Promise<{ text: string }> {
  const conv = await getConversation(d.db, conversationId)
  const names = conv ? await clientNames(d.db, conv) : []
  const variants = ([0, 1] as const).map((v) => reminderFallback(names[0] ?? null, p.tone, v))
  const used = conv ? await ladderTexts(d.db, conv.id) : new Set<string>()
  if (conv) {
    const ours = await d.db
      .select({ text: chatMessage.text })
      .from(chatMessage)
      .where(and(eq(chatMessage.conversationId, conv.id), eq(chatMessage.side, 'specialist')))
    for (const m of ours) used.add(normalizeText(m.text))
  }
  const [last] = conv
    ? await d.db
        .select({ text: convTurn.text })
        .from(convTurn)
        .where(
          and(
            eq(convTurn.conversationId, conv.id),
            eq(convTurn.kind, 'reminder'),
            eq(convTurn.outcome, 'sent'),
          ),
        )
        .orderBy(desc(convTurn.createdAt))
        .limit(1)
    : []
  const text =
    variants.find((v) => !used.has(normalizeText(v))) ??
    variants.find((v) => normalizeText(v) !== normalizeText(last?.text ?? '')) ??
    (variants[0] as string)
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

/** The reminder step is done when Boris has its card: the row says so together with its event. */
async function endCard(
  d: RemindDeps,
  rowId: string,
  conv: ConversationRow,
  p: Planned,
  text: string,
): Promise<void> {
  if (await endedWith(d, rowId, 'carded')) return
  await d.db.transaction(async (tx) => {
    await finishRow(tx, rowId, {
      text,
      outcome: 'carded',
      decision: 'draft',
      decisionReason: 'карточка Борису: отправлю по его нажатию',
    })
    await journal(tx, 'conv.reminder_drafted', conv, rowId, { step: p.step, card: true })
  })
}

/** The card could not be sent to Boris in all the tries: the row says why, the ladder goes on with its next step. */
export async function giveUpCard(d: RemindDeps, rowId: string): Promise<void> {
  await finishRow(d.db, rowId, {
    outcome: 'failed',
    decision: 'draft',
    decisionReason: 'не смогла прислать карточку Борису',
  })
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
  if (queued) {
    // A repeat after a crash: the message is queued, the chat is not asked again (the service still refuses a chat
    // that moved on). But the switches may have changed since: the queue says yes again only when sending is allowed.
    const again = (await accountHolds(d.db, conv.accountId))
      ? null
      : await d.db.transaction((tx) =>
          queueMessage(tx, {
            key: rowId,
            accountId: conv.accountId,
            chatId: conv.chatId,
            text,
            author: 'sara',
            expectLast: null,
          }),
        )
    if (again) return deliver(d, rowId, conv, again, p)
    await finishRow(d.db, rowId, {
      outcome: 'skipped',
      decision: 'nothing',
      decisionReason: 'сейчас не отправляю: пауза, пауза аккаунта, режим тени или режим черновиков',
    })
    return { outcome: 'skipped', end: false }
  }
  // Drafts mode: an earlier run of this step already sent Boris the card; it is not sent twice.
  const [made] = await d.db
    .select({ taskId: convTurn.taskId, state: convTurn.state })
    .from(convTurn)
    .where(eq(convTurn.id, rowId))
  if (made?.taskId) {
    if (made.state !== 'finished') await endCard(d, rowId, conv, p, text)
    return { outcome: 'carded', end: false }
  }
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
  // Drafts mode (FR-CONV-5): Sara sends nothing by herself, Boris gets the card and his press sends the text.
  if (!(await getSetting(d.db, 'conv.autopilot'))) {
    try {
      await sendReminderCard(d, rowId, conv, p.step as 1 | 2 | 3, text)
    } catch (e) {
      console.error('reminder: the card did not go', e instanceof Error ? e.message : e)
      return { outcome: 'failed', end: false, retry: true }
    }
    await endCard(d, rowId, conv, p, text)
    return { outcome: 'carded', end: false }
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

/** The deal of a client silent after the reminders becomes dormant; a stage that cannot (a booked meeting) stays. */
async function dormantDeal(d: RemindDeps, conv: ConversationRow, sent: number): Promise<void> {
  // Nothing went to him: his silence says nothing about the deal.
  if (!conv.dealId || sent === 0) return
  try {
    await transition(d.db, {
      dealId: conv.dealId,
      to: 'dormant',
      actor: 'sara',
      reason: silentReason(sent),
      correlationId: conv.id,
    })
  } catch (e) {
    // Already dormant, or a stage that cannot become dormant: the task has gone all the same.
    if (!(e instanceof TransitionError)) throw e
  }
}

const silentReason = (sent: number) =>
  sent > 0 ? `клиент молчит после напоминаний: ${sent}` : 'клиент молчит, напоминания не уходили'

/**
 * Three days after the third reminder the client is still silent. In shadow only the trace says so. After the switch
 * the deal, if there is one, becomes dormant and Boris gets one task «Клиент молчит после трёх напоминаний» with
 * «Закрыть» only: nothing more is written to the client (design 5.11, Boris's rule 11).
 */
export async function dormantStep(
  d: RemindDeps,
  rowId: string,
  conversationId: string,
  shadow: boolean,
): Promise<{ asked: boolean }> {
  const conv = await getConversation(d.db, conversationId)
  if (!conv) return { asked: false }
  // How many reminders of this ladder really went (the cards may have been ignored, declined or held by a pause).
  const [went] = await d.db
    .select({ n: sql<number>`count(*)::int` })
    .from(convTurn)
    .where(
      and(
        eq(convTurn.conversationId, conv.id),
        eq(convTurn.kind, 'reminder'),
        eq(convTurn.outcome, 'sent'),
        like(convTurn.id, `${rowId.slice(0, rowId.lastIndexOf(':'))}:%`),
      ),
    )
  const sent = went?.n ?? 0
  // The step ends when its work is done, so a row that is finished has its task too.
  const settle = async () => {
    if (await endedWith(d, rowId, 'dormant')) return
    await d.db.transaction(async (tx) => {
      await finishRow(tx, rowId, {
        outcome: 'dormant',
        decision: shadow ? 'trace' : 'task',
        decisionReason: shadow ? 'в тени задача Борису только в трассе' : silentReason(sent),
      })
      await journal(tx, 'conv.dormant', conv, rowId, { shadow })
    })
  }
  if (shadow) {
    await settle()
    return { asked: false }
  }
  const [have] = await d.db
    .select({ id: task.id })
    .from(task)
    .where(and(eq(task.kind, 'conv_dormant'), eq(task.entityId, rowId)))
  if (have) {
    await dormantDeal(d, conv, sent)
    await expireOldCards(d.db, conv.id, rowId, 'больше напоминаний не будет')
    await settle()
    return { asked: true }
  }
  const [l] = conv.orderId ? await d.db.select().from(lead).where(eq(lead.id, conv.orderId)) : []
  const taskId = newEventId()
  const m = await d.notifier.sendButtons(
    CONV_TEXTS.dormant(l?.clientName || null, l?.title ?? null, sent),
    [[{ text: CONV_TEXTS.buttons.close, callbackData: formatCallback(taskId, 'close') }]],
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
  // The deal moves only with the task: a task that could not be sent leaves it where it is (a retry follows).
  await dormantDeal(d, conv, sent)
  // After «Больше напоминать не буду» no reminder card may go: the ones that still wait are closed.
  await expireOldCards(d.db, conv.id, rowId, 'больше напоминаний не будет')
  await settle()
  return { asked: true }
}
