import { type Actor, formatCallback, newEventId, type TaskAction } from '@sara/shared'
import { and, desc, eq, inArray, isNull, like, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { chatMessage, convTurn, outbox, question, task } from '../db/schema'
import { TransitionError, transition } from '../domain/deal'
import { redact } from '../gateway/redact'
import { appendEvent } from '../journal/journal'
import type { BorisReply } from '../learning/inbox'
import type { QuestionRow } from '../learning/questions'
import { proposeMind } from '../mind/proposals'
import type { Notifier } from '../notify/notifier'
import { getSetting } from '../settings/store'
import { clientNames } from './dossier'
import { expectLastAfter, lastSeen } from './outbox'
import { editReminder, onReminderPress } from './reminderCard'
import { holdText, sendHold } from './sendHold'
import { type SendOptions, STALE_DRAFT } from './sendTexts'
import { getConversation, updateConversation } from './store'
import { CONV_TEXTS, REMIND_TEXTS } from './texts'

import type { ConversationRow } from './types'

export type CommandDeps = {
  db: Db
  notifier: Pick<Notifier, 'sendText' | 'closeTopic'>
  /** After the switch: a text goes to the client through the outbox (part C6); the answer is for Boris. */
  sendText?(
    conversationId: string,
    text: string,
    author: 'sara' | 'boris',
    o?: SendOptions,
  ): Promise<string>
  /**
   * Boris's plain words in a client's topic, read as the story of a call (the outcome and the next step go on the meeting
   * card); a line for him when they were, null when they are for the client or about something else.
   */
  meetingResult?(conv: ConversationRow, text: string, at: Date): Promise<string | null>
  /**
   * The chat in a client's topic (docs/superpowers/specs/2026-11-07-topic-chat-design.md): his plain words there go to
   * Sara, who rewrites the draft by them; her answer comes on its own. Without it, his words are his text for the client.
   */
  topicChat?: {
    take(w: {
      conversationId: string
      text: string
      voice: boolean
      messageRef?: number
      at: Date
    }): Promise<void>
  }
}

export const COMMAND_TEXTS = {
  done: 'Это уже сделано.',
  taken: 'Клиент твой: я ему не пишу и не напоминаю, его новые сообщения пришлю тебе.',
  returned: 'Вернула клиента себе. Сейчас ничего не пишу, отвечу на его следующее сообщение.',
  closed: 'Разговор закрыт: не пишу и не напоминаю. Вернуть можно «Вернуть».',
  good: 'Отметила: черновик годный.',
  askEdit:
    'Жду твой вариант ответа клиенту: пришли его ответом на это сообщение, текстом или голосом.',
  editKept: 'Сохранила твой вариант рядом с моим. Клиенту ничего не ушло: режим тени.',
  shadowSay:
    'Режим тени: я пока не пишу клиентам. Сохранила твой текст как твой ответ, отправь его сам в Профи.ру.',
  shadowSend: 'Режим тени: я пока не пишу клиентам. Отправь сам в Профи.ру, если текст подходит.',
  notUnderstood:
    'Не поняла. Ответь на карточку словами: «беру сам», «верни», «закрой» или «напиши: …». Чтобы ушёл мой черновик, нажми «Отправить».',
  noDraft: 'В этой карточке нет текста для клиента.',
  alreadySent: 'Ответ уже ушёл клиенту или стоит в очереди. Второй раз не отправляю.',
  sendUncertain:
    'Не уверена, что прошлая отправка дошла. Проверь чат в Профи.ру, повторно не отправляю.',
  answeredYourself:
    'Ты уже ответил сам: в чате есть твоё сообщение после слов клиента. Черновик не отправляю.',
  stale: STALE_DRAFT,
  /** A typed «да» never sends: only the button does (the review of the drafts mode). */
  pressSend: 'Нажми «Отправить», и уйдёт',
  pressGood: 'Нажми «Хорошо», и отмечу, что черновик годный',
  askText: 'Что отправить клиенту? Пришли текст после двоеточия: «напиши: …».',
  sayAsked: 'Я уже спросила про этот текст: нажми «Отправить» или «Изменить» под моим вопросом.',
  sayConfirm: (words: string) => `Отправлю клиенту так: «${words}»`,
  /** The forum (docs/product/telegram-forum.md): words in a client's topic. */
  noChatYet:
    'С этим клиентом ещё нет чата: он не ответил на отклик. Твой текст не отправляю, пришли его, когда клиент напишет.',
  nothingToSend:
    'Здесь нечего отправлять: нет открытого черновика. Напиши текст, и я предложу его отправить.',
  askFree: 'Пришли сюда новый вариант, и я покажу его перед отправкой.',
  /** «Изменить» under a version of the topic chat: his next words are a correction, not the text itself. */
  chatEdit:
    'Напиши здесь, что поправить, текстом или голосом. Можно прислать и свой вариант целиком.',
  topicClosed:
    '📁 Разговор закрыт: не пишу и не напоминаю. Клиент напишет, и тема откроется снова.',
}

type CardTask = typeof task.$inferSelect

async function journal(
  db: Db,
  type:
    | 'conv.taken'
    | 'conv.returned'
    | 'conv.closed'
    | 'conv.said'
    | 'conv.draft_good'
    | 'conv.draft_edited',
  conversationId: string,
  actor: Actor,
  payload: Record<string, unknown> = {},
) {
  const conv = await getConversation(db, conversationId)
  await appendEvent(db, {
    type,
    v: 1,
    entity: { kind: 'conversation', id: conversationId },
    account_id: conv?.accountId ?? null,
    actor,
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: conversationId,
    reason: null,
    payload,
  })
}

/**
 * Closes the conversation's open cards: one decision answers them all. The reminder rows whose card waited end with
 * it, so the numbers of the report are right.
 */
async function resolveCards(db: Db, conversationId: string, resolution: string) {
  const turns = await db
    .select({ taskId: convTurn.taskId })
    .from(convTurn)
    .where(eq(convTurn.conversationId, conversationId))
  for (const t of turns)
    if (t.taskId)
      await db
        .update(task)
        .set({ state: 'resolved', resolution, resolvedAt: new Date().toISOString() })
        .where(and(eq(task.id, t.taskId), eq(task.state, 'open')))
  await db
    .update(convTurn)
    .set({
      outcome: 'stopped',
      decision: 'nothing',
      decisionReason: resolution === 'take' ? 'клиента взял Борис' : 'разговор закрыт',
    })
    .where(
      and(
        eq(convTurn.conversationId, conversationId),
        eq(convTurn.kind, 'reminder'),
        eq(convTurn.outcome, 'carded'),
      ),
    )
}

/** «Беру сам» (FR-CONV-11): Boris leads the client; drafts and reminders stop. */
export async function take(db: Db, conversationId: string, actor: Actor = 'boris'): Promise<void> {
  await updateConversation(db, conversationId, { owner: 'boris', ownerReason: 'take' })
  await resolveCards(db, conversationId, 'take')
  await journal(db, 'conv.taken', conversationId, actor)
}

const moscowDate = (d: Date) =>
  d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' })

/**
 * «Вернуть» (FR-CONV-11): Sara leads again, with Boris's note kept for every next turn. As old Sara did, nothing is
 * answered now: what the client already wrote is marked as handled, the next message gets the reply.
 */
export async function giveBack(db: Db, conversationId: string, note: string | null): Promise<void> {
  const conv = await getConversation(db, conversationId)
  if (!conv) return
  const [last] = await db
    .select({ id: chatMessage.platformMessageId })
    .from(chatMessage)
    .where(and(eq(chatMessage.conversationId, conversationId), eq(chatMessage.side, 'client')))
    .orderBy(desc(chatMessage.sentAt), desc(chatMessage.platformMessageId))
    .limit(1)
  const borisNote = note
    ? [conv.borisNote, `${moscowDate(new Date())}: ${note}`].filter(Boolean).join('\n')
    : conv.borisNote
  await updateConversation(db, conversationId, {
    owner: 'sara',
    ownerReason: null,
    closedAt: null,
    borisNote,
    handledThrough: last?.id ?? conv.handledThrough,
  })
  await journal(db, 'conv.returned', conversationId, 'boris', { with_note: note !== null })
}

/**
 * «Закрыть» (FR-CONV-11): no turns, no reminders; the deal, when the new Sara made the bid, is lost. In the forum the
 * client's topic gets the outcome and closes.
 */
export async function close(
  db: Db,
  conversationId: string,
  topics?: Pick<Notifier, 'closeTopic'>,
): Promise<void> {
  const conv = await updateConversation(db, conversationId, { closedAt: new Date().toISOString() })
  await resolveCards(db, conversationId, 'close')
  if (conv.dealId) {
    try {
      await transition(db, {
        dealId: conv.dealId,
        to: 'lost',
        actor: 'boris',
        reason: 'закрыл Борис',
        correlationId: conversationId,
      })
    } catch (e) {
      if (!(e instanceof TransitionError)) throw e
    }
  }
  await journal(db, 'conv.closed', conversationId, 'boris')
  await topics?.closeTopic?.({ conversation: conversationId }, COMMAND_TEXTS.topicClosed)
}

/** The latest turn of a conversation: Boris's words are kept beside its draft. */
async function latestTurn(db: Db, conversationId: string) {
  const [t] = await db
    .select()
    .from(convTurn)
    .where(and(eq(convTurn.conversationId, conversationId), eq(convTurn.kind, 'reply')))
    .orderBy(desc(convTurn.createdAt))
    .limit(1)
  return t ?? null
}

/** Boris's own answer becomes a proposal of a speech example, never a mind record by itself (FR-MIND-3). */
async function proposeBorisWords(db: Db, turnId: string, conversationId: string, text: string) {
  const conv = await getConversation(db, conversationId)
  if (!conv) return
  // A name that is not known cannot be hidden: Boris's words are then kept beside the draft and go nowhere else.
  const names = await clientNames(db, conv)
  if (names.length === 0) return
  const [t] = await db.select().from(convTurn).where(eq(convTurn.id, turnId))
  const ids = (t?.messageIds as string[]) ?? []
  const client = ids.length
    ? (
        await db
          .select({ text: chatMessage.text, id: chatMessage.platformMessageId })
          .from(chatMessage)
          .where(eq(chatMessage.conversationId, conversationId))
      )
        .filter((m) => ids.includes(m.id))
        .map((m) => m.text)
        .join('\n')
    : ''
  const hide = (s: string) => redact(s, names).text
  const id = `e-b-${turnId
    .replace(/[^a-z0-9]/gi, '')
    .slice(-24)
    .toLowerCase()}`
  const today = new Date().toISOString().slice(0, 10)
  const content = [
    '---',
    `id: ${id}`,
    'type: example',
    'scope: shared',
    'status: proposal',
    'version: 1',
    `sources: ['boris:${turnId}']`,
    `valid_from: ${today}`,
    'valid_to: null',
    '---',
    '',
    '## Клиент',
    '',
    hide(client),
    '',
    '## Борис',
    '',
    hide(text),
    '',
  ].join('\n')
  await proposeMind(db, {
    path: `mind/proposals/shared/speech/examples/${id}.md`,
    content,
    kind: 'example',
    source: `boris:${turnId}`,
  })
}

/**
 * «Написать текст» (FR-CONV-11): Boris's own words go to the client as they are, after the switch even on the
 * «Пишет клиентам» pause; in shadow they are kept as his answer beside Sara's draft and sent by nobody.
 */
export async function say(
  d: CommandDeps,
  conversationId: string,
  text: string,
  /** What makes a repeat of the same request the same message (a Telegram message, an API key). */
  key?: string,
): Promise<string> {
  const t = await latestTurn(d.db, conversationId)
  if (t) {
    await d.db.update(convTurn).set({ borisText: text }).where(eq(convTurn.id, t.id))
    await proposeBorisWords(d.db, t.id, conversationId, text)
  }
  await journal(d.db, 'conv.said', conversationId, 'boris')
  if ((await getSetting(d.db, 'conv.v1_writes')) || !d.sendText) return COMMAND_TEXTS.shadowSay
  // His text answers the card of that turn: the draft behind it cannot go too.
  if (t?.taskId) await closeCard(d.db, t.taskId, 'say')
  return d.sendText(conversationId, text, 'boris', { key })
}

/** The card's task is resolved once; false when it already was. */
async function closeCard(db: Db, taskId: string, resolution: string): Promise<boolean> {
  const rows = await db
    .update(task)
    .set({ state: 'resolved', resolution, resolvedAt: new Date().toISOString() })
    .where(and(eq(task.id, taskId), eq(task.state, 'open')))
    .returning({ id: task.id })
  return rows.length > 0
}

/**
 * Why a draft must not go out on «Отправить», or null: the turn's own reply is already in the outbox (queued or
 * sent, or unsure whether it went), or our side wrote in the chat after the client messages the draft answers.
 */
async function sendRefusal(db: Db, turn: typeof convTurn.$inferSelect): Promise<string | null> {
  // The turn's own reply (autopilot), and what a press on any card of this turn sent (`send:<card task>`).
  const cards = await db
    .select({ id: task.id })
    .from(task)
    .where(and(eq(task.entityKind, 'conv_turn'), eq(task.entityId, turn.id)))
  const pressKeys = cards.map((c) => `msg:send:${c.id}`)
  const own = await db
    .select({ state: outbox.state })
    .from(outbox)
    .where(
      and(
        eq(outbox.kind, 'message'),
        pressKeys.length > 0
          ? or(
              like(outbox.idempotencyKey, `msg:${turn.id}:%`),
              inArray(outbox.idempotencyKey, pressKeys),
            )
          : like(outbox.idempotencyKey, `msg:${turn.id}:%`),
      ),
    )
  if (own.some((r) => r.state === 'queued' || r.state === 'confirmed'))
    return COMMAND_TEXTS.alreadySent
  if (own.some((r) => r.state === 'uncertain')) return COMMAND_TEXTS.sendUncertain
  const covered = ((turn.messageIds as string[] | null) ?? []).at(-1)
  if (!covered) return null
  const chat = await db
    .select({
      id: chatMessage.platformMessageId,
      side: chatMessage.side,
      author: chatMessage.author,
    })
    .from(chatMessage)
    .where(eq(chatMessage.conversationId, turn.conversationId))
    .orderBy(chatMessage.sentAt, chatMessage.platformMessageId)
  const at = chat.findIndex((m) => m.id === covered)
  const ours = at >= 0 ? chat.slice(at + 1).find((m) => m.side === 'specialist') : undefined
  if (!ours) return null
  return ours.author === 'sara' ? COMMAND_TEXTS.alreadySent : COMMAND_TEXTS.answeredYourself
}

async function cardTaskOf(db: Db, taskId: string): Promise<CardTask | null> {
  const [t] = await db.select().from(task).where(eq(task.id, taskId))
  return t && t.kind === 'conv_draft' ? t : null
}

/** A press on the task of a client silent after three reminders: «Закрыть» closes the conversation (FR-CONV-12). */
async function onDormantPress(d: CommandDeps, t: CardTask, action: TaskAction): Promise<string> {
  if (t.state !== 'open') return COMMAND_TEXTS.done
  if (action !== 'close') return COMMAND_TEXTS.notUnderstood
  const [row] = await d.db.select().from(convTurn).where(eq(convTurn.id, t.entityId))
  if (!row) return COMMAND_TEXTS.done
  await close(d.db, row.conversationId, d.notifier)
  return COMMAND_TEXTS.closed
}

/** A press on a conversation card (C5 actions: good, edit, send, take, return, close). */
export async function onConvPress(
  d: CommandDeps,
  p: { taskId: string; action: TaskAction },
): Promise<string> {
  const [dormant] = await d.db.select().from(task).where(eq(task.id, p.taskId))
  if (dormant?.kind === 'conv_dormant') return onDormantPress(d, dormant, p.action)
  if (dormant?.kind === 'conv_say') return onSayPress(d, dormant, p.action)
  const t = await cardTaskOf(d.db, p.taskId)
  const [turn] = t ? await d.db.select().from(convTurn).where(eq(convTurn.id, t.entityId)) : []
  if (!t || !turn) return COMMAND_TEXTS.done
  const conversationId = turn.conversationId
  if (turn.kind === 'reminder') return onReminderCardPress(d, t, turn, p.action)
  if (p.action === 'return') {
    await giveBack(d.db, conversationId, null)
    return COMMAND_TEXTS.returned
  }
  if (t.state !== 'open') return COMMAND_TEXTS.done
  switch (p.action) {
    case 'take':
      await take(d.db, conversationId)
      return COMMAND_TEXTS.taken
    case 'close':
      await close(d.db, conversationId, d.notifier)
      return COMMAND_TEXTS.closed
    case 'good':
      await d.db
        .update(task)
        .set({ state: 'resolved', resolution: 'good', resolvedAt: new Date().toISOString() })
        .where(and(eq(task.id, t.id), eq(task.state, 'open')))
      await journal(d.db, 'conv.draft_good', conversationId, 'boris', { turn_id: turn.id })
      return COMMAND_TEXTS.good
    case 'edit':
      await startEdit(d, turn.id)
      return COMMAND_TEXTS.askEdit
    case 'send': {
      if (await getSetting(d.db, 'conv.v1_writes')) return COMMAND_TEXTS.shadowSend
      if (!turn.text || !d.sendText) return COMMAND_TEXTS.noDraft
      // A pause, a paused or logged out account: the card is not taken for nothing, it stays for a later press.
      const hold = await sendHold(d.db, conversationId, 'sara')
      if (hold) return holdText(hold)
      const refusal = await sendRefusal(d.db, turn)
      if (refusal) return refusal
      // The press is taken once; the service is told the last client message this draft answers, so a chat that
      // moved on is refused there (CHAT_CHANGED) and not answered over.
      const claimed = await closeCard(d.db, t.id, 'send')
      if (!claimed) return COMMAND_TEXTS.done
      const covered = ((turn.messageIds as string[] | null) ?? []).at(-1)
      return d.sendText(conversationId, turn.text, 'sara', {
        expectLast: await expectLastAfter(d.db, conversationId, covered),
        key: `send:${t.id}`,
        after: { kind: 'draft', taskId: t.id },
      })
    }
    default:
      return COMMAND_TEXTS.notUnderstood
  }
}

/** A press on the card of a reminder (drafts mode): «Отправить», «Изменить» or «Не надо». */
async function onReminderCardPress(
  d: CommandDeps,
  t: CardTask,
  turn: typeof convTurn.$inferSelect,
  action: TaskAction,
): Promise<string> {
  if (t.state !== 'open')
    return ['expired', 'answered', 'stale'].includes(t.resolution ?? '')
      ? REMIND_TEXTS.notNeeded
      : COMMAND_TEXTS.done
  if (turn.outcome !== 'carded') return COMMAND_TEXTS.done
  if (action === 'edit') {
    await startEdit(d, turn.id)
    return COMMAND_TEXTS.askEdit
  }
  return onReminderPress(d, t, turn, action)
}

/** «Изменить»: a question whose answer is Boris's version of the reply. */
async function startEdit(d: CommandDeps, turnId: string): Promise<void> {
  const id = newEventId()
  const now = new Date()
  const [turn] = await d.db
    .select({ conversationId: convTurn.conversationId })
    .from(convTurn)
    .where(eq(convTurn.id, turnId))
  await d.db
    .insert(question)
    .values({ id, kind: 'conv_edit', entityId: turnId, askedAt: now.toISOString() })
  const m = await d.notifier.sendText(
    COMMAND_TEXTS.askEdit,
    turn ? { place: { conversation: turn.conversationId } } : undefined,
  )
  await d.db.update(question).set({ telegramMessageId: m.messageId }).where(eq(question.id, id))
}

/**
 * Boris's version after «Изменить»: kept beside the draft (in shadow); after the switch it is shown back to him with
 * «Отправить» and «Изменить», and only that press sends it, with exactly these words.
 */
export async function onConvEdit(
  d: CommandDeps,
  a: { question: QuestionRow; text: string; voice: boolean; at: Date; messageId?: number },
): Promise<BorisReply> {
  await d.db
    .update(question)
    .set({ answeredAt: a.at.toISOString(), answer: a.text })
    .where(and(eq(question.id, a.question.id), isNull(question.answeredAt)))
  const [turn] = await d.db.select().from(convTurn).where(eq(convTurn.id, a.question.entityId))
  if (!turn) return COMMAND_TEXTS.done
  if ((await getSetting(d.db, 'conv.v1_writes')) || !d.sendText) {
    await d.db.update(convTurn).set({ borisText: a.text }).where(eq(convTurn.id, turn.id))
    // A reminder has no client words to be an example of: only a reply's draft becomes a proposal.
    if (turn.kind !== 'reminder')
      await proposeBorisWords(d.db, turn.id, turn.conversationId, a.text)
    await journal(d.db, 'conv.draft_edited', turn.conversationId, 'boris', {
      turn_id: turn.id,
      voice: a.voice,
    })
    return COMMAND_TEXTS.editKept
  }
  return proposeSay(d, turn, a.text, { via: 'edit', voice: a.voice, messageId: a.messageId })
}

/**
 * Boris's own words for the client after the switch (his «напиши: …» or his version after «Изменить»): nothing goes
 * yet. Sara shows the exact words back with «Отправить» and «Изменить»; only the press on «Отправить» sends them
 * (design 5.10). The words are kept in a row of their own, so a later version never changes what this press sends.
 */
export async function proposeSay(
  d: CommandDeps,
  parent: typeof convTurn.$inferSelect,
  text: string,
  o: { via: 'say' | 'edit'; voice?: boolean; messageId?: number; chat?: boolean },
): Promise<BorisReply> {
  const [card] = parent.taskId
    ? await d.db.select().from(task).where(eq(task.id, parent.taskId))
    : []
  if (!card || card.state !== 'open') return COMMAND_TEXTS.done
  const rowId =
    o.messageId !== undefined
      ? `conv-say:${parent.id}:tg:${o.messageId}`
      : `conv-say:${parent.id}:${newEventId()}`
  const taskId = newEventId()
  const made = await d.db.transaction(async (tx) => {
    const rows = await tx
      .insert(convTurn)
      .values({
        id: rowId,
        conversationId: parent.conversationId,
        kind: 'say',
        anchorMessageId: parent.anchorMessageId,
        messageIds: parent.messageIds,
        state: 'decided',
        text,
        decision: 'say',
        understanding: {
          parent: parent.id,
          via: o.via,
          voice: o.voice ?? false,
          key: sayKey(o),
          ...(o.chat && { chat: true }),
        },
        taskId,
      })
      .onConflictDoNothing()
      .returning({ id: convTurn.id })
    if (rows.length === 0) return false
    await tx.insert(task).values({
      id: taskId,
      kind: 'conv_say',
      entityKind: 'conv_turn',
      entityId: rowId,
      priority: 'P1',
    })
    return true
  })
  if (!made) return COMMAND_TEXTS.sayAsked
  const b = (label: string, action: TaskAction) => ({
    text: label,
    callbackData: formatCallback(taskId, action),
  })
  return {
    text: COMMAND_TEXTS.sayConfirm(text),
    rows: [[b(CONV_TEXTS.buttons.send, 'send'), b(CONV_TEXTS.buttons.edit, 'edit')]],
  }
}

/** What makes a repeat of the same Telegram message, or the press on its confirmation, the same message. */
const sayKey = (o: { messageId?: number }) =>
  o.messageId === undefined ? null : `say:tg:${o.messageId}`

/** A press on «Отправить» or «Изменить» under Sara's «Отправлю клиенту так: …». */
async function onSayPress(d: CommandDeps, st: CardTask, action: TaskAction): Promise<string> {
  if (st.state !== 'open') return COMMAND_TEXTS.done
  const [say] = await d.db.select().from(convTurn).where(eq(convTurn.id, st.entityId))
  const meta = (say?.understanding ?? {}) as {
    parent?: string
    via?: 'say' | 'edit'
    key?: string | null
  }
  if (action === 'edit' && (meta as { chat?: boolean }).chat) {
    if (!(await closeCard(d.db, st.id, 'edit'))) return COMMAND_TEXTS.done
    return COMMAND_TEXTS.chatEdit
  }
  if (say?.text && (meta as { free?: boolean }).free) return onFreeSayPress(d, st, say, action)
  const [parent] = meta.parent
    ? await d.db.select().from(convTurn).where(eq(convTurn.id, meta.parent))
    : []
  if (!say?.text || !parent) return COMMAND_TEXTS.done
  if (action === 'edit') {
    if (!(await closeCard(d.db, st.id, 'edit'))) return COMMAND_TEXTS.done
    await startEdit(d, parent.id)
    return COMMAND_TEXTS.askEdit
  }
  if (action !== 'send') return COMMAND_TEXTS.notUnderstood
  if (await getSetting(d.db, 'conv.v1_writes')) return COMMAND_TEXTS.shadowSend
  if (!d.sendText) return COMMAND_TEXTS.noDraft
  const hold = await sendHold(d.db, parent.conversationId, 'boris')
  if (hold) return holdText(hold)
  const [card] = parent.taskId
    ? await d.db.select().from(task).where(eq(task.id, parent.taskId))
    : []
  if (!card || card.state !== 'open') return COMMAND_TEXTS.alreadySent
  const via = meta.via ?? 'say'
  const key = meta.key ?? `say:${st.id}`
  const words = say.text
  if (parent.kind === 'reminder') {
    // The reread of the chat may say «not now» (a pause): then nothing is taken and the question stays.
    await d.db.update(convTurn).set({ borisText: words }).where(eq(convTurn.id, parent.id))
    const answer = await editReminder(d, parent, words, key)
    const [after] = await d.db.select().from(task).where(eq(task.id, card.id))
    if (after && after.state !== 'open') {
      await closeCard(d.db, st.id, 'send')
      await journal(d.db, 'conv.draft_edited', parent.conversationId, 'boris', {
        turn_id: parent.id,
      })
    }
    return answer
  }
  const refusal = await sendRefusal(d.db, parent)
  if (refusal) return refusal
  // His words answer the card: the draft behind it cannot go too.
  if (!(await closeCard(d.db, card.id, via === 'edit' ? 'edit' : 'say')))
    return COMMAND_TEXTS.alreadySent
  await closeCard(d.db, st.id, 'send')
  await d.db.update(convTurn).set({ borisText: words }).where(eq(convTurn.id, parent.id))
  await proposeBorisWords(d.db, parent.id, parent.conversationId, words)
  await journal(
    d.db,
    via === 'edit' ? 'conv.draft_edited' : 'conv.said',
    parent.conversationId,
    'boris',
    { turn_id: parent.id },
  )
  const covered = ((parent.messageIds as string[] | null) ?? []).at(-1)
  return d.sendText(parent.conversationId, words, 'boris', {
    expectLast: await expectLastAfter(d.db, parent.conversationId, covered),
    key,
  })
}

/** A message of Boris's in Telegram is one message to the client however often the update is delivered. */
const telegramKey = (messageId: number | undefined) =>
  messageId === undefined ? undefined : `say:tg:${messageId}`

export type CardCommand =
  | { cmd: 'take' }
  | { cmd: 'return'; note: string | null }
  /** His own words after the colon; null when the command leaves no text, and Sara asks for it. */
  | { cmd: 'say'; text: string | null }
  | { cmd: 'close' }
  /** «да», «ок», «отправляй»: no command, a nudge to press the button. */
  | { cmd: 'confirm' }

const CONFIRM_WORD =
  '(?:да|ага|ок|окей|окай|хорошо|годится|норм|отлично|давай|отправляй|отправь|отправить|как есть)'
/** The whole message is a confirmation (a voice recognition adds commas and dots): «Да, отправляй.» */
const CONFIRM = new RegExp(
  `^(?:ну\\s+)?${CONFIRM_WORD}(?:[\\s,.!)👍]+(?:${CONFIRM_WORD}|так|пожалуйста))*[\\s.,!)👍]*$`,
  'iu',
)
const END = '[\\s.!)]*$'
const TAKE = new RegExp(
  `^(?:я\\s+сам(?:а)?|(?:беру|возьму)(?:\\s+(?:её|ее|его|клиента|клиентку))?(?:\\s+сам(?:а)?)?)${END}`,
  'iu',
)
const CLOSE = new RegExp(
  `^(?:закрой|закрыть|закрываем)(?:\\s+(?:разговор|диалог|его|её|ее|клиента))?${END}`,
  'iu',
)
const WHO = '(?:\\s+(?:ей|ему|клиенту|клиентке))?'
const SAY_COLON = new RegExp(`^(?:напиши|отправь|ответь)${WHO}\\s*:\\s*(.*)$`, 'isu')
const SAY_BARE = new RegExp(`^(?:напиши|отправь|отправляй|ответь)${WHO}${END}`, 'iu')

/**
 * Boris's words in reply to a card, read as a command; anything else is not guessed (FR-NOTIF-1). A command is the
 * whole message: «Закрыть не надо, подожди» closes nothing, and only a colon makes the words after a command word his
 * text («напиши: …»), so «Напиши ему, что я перезвоню» is never cut into «что я перезвоню».
 */
export function parseCardReply(text: string): CardCommand | null {
  const t = text.trim()
  if (TAKE.test(t)) return { cmd: 'take' }
  const back = /^(?:верни|вернуть)(?!\p{L})(?:\s+саре)?\s*[:,.-]?\s*(.*)$/isu.exec(t)
  if (back) return { cmd: 'return', note: back[1]?.trim() || null }
  // «отправь», «отправляй» alone are a confirmation; with «ему» and no text they ask for the text.
  if (CONFIRM.test(t)) return { cmd: 'confirm' }
  const say = SAY_COLON.exec(t)
  if (say) return { cmd: 'say', text: say[1]?.trim() || null }
  if (SAY_BARE.test(t)) return { cmd: 'say', text: null }
  if (CLOSE.test(t)) return { cmd: 'close' }
  return null
}

/**
 * A reply to a conversation card: null when it is not a reply to one (the message is someone else's business). A typed
 * reply never sends a draft: «да» points at the card's own «Отправить», and Boris's own words are shown back to him
 * and go only on that press (the review of the drafts mode).
 */
export async function onConvReply(
  d: CommandDeps,
  m: {
    replyToMessageId: number | null
    text: string
    voice?: boolean
    messageId?: number
    at: Date
  },
): Promise<BorisReply | null> {
  if (m.replyToMessageId === null) return null
  const [t] = await d.db
    .select()
    .from(task)
    .where(and(eq(task.telegramMessageId, m.replyToMessageId), eq(task.kind, 'conv_draft')))
  const [turn] = t ? await d.db.select().from(convTurn).where(eq(convTurn.id, t.entityId)) : []
  if (!t || !turn) return null
  const live = !(await getSetting(d.db, 'conv.v1_writes'))
  const c = parseCardReply(m.text)
  if (!c) {
    // «Изменить» waits for his version: his words on the card are it, even without a command word.
    const [edit] = await d.db
      .select()
      .from(question)
      .where(
        and(
          eq(question.kind, 'conv_edit'),
          eq(question.entityId, turn.id),
          isNull(question.answeredAt),
        ),
      )
    if (edit)
      return onConvEdit(d, {
        question: edit,
        text: m.text,
        voice: m.voice ?? false,
        messageId: m.messageId,
        at: m.at,
      })
    return COMMAND_TEXTS.notUnderstood
  }
  switch (c.cmd) {
    case 'take':
      await take(d.db, turn.conversationId)
      return COMMAND_TEXTS.taken
    case 'return':
      await giveBack(d.db, turn.conversationId, c.note)
      return COMMAND_TEXTS.returned
    case 'say':
      if (c.text === null) return COMMAND_TEXTS.askText
      if (!live) return say(d, turn.conversationId, c.text, telegramKey(m.messageId))
      return proposeSay(d, turn, c.text, {
        via: 'say',
        voice: m.voice,
        messageId: m.messageId,
      })
    case 'close':
      await close(d.db, turn.conversationId, d.notifier)
      return COMMAND_TEXTS.closed
    case 'confirm': {
      // A typed «да» sends nothing. The button of the same card does, through the usual press.
      if (t.state !== 'open') return COMMAND_TEXTS.done
      const action: TaskAction = live ? (turn.text ? 'send' : 'edit') : 'good'
      return {
        text: live ? COMMAND_TEXTS.pressSend : COMMAND_TEXTS.pressGood,
        rows: [
          [
            {
              text: live ? CONV_TEXTS.buttons.send : CONV_TEXTS.buttons.good,
              callbackData: formatCallback(t.id, action),
            },
          ],
        ],
      }
    }
  }
}

/** The open «Изменить» of a conversation: his next words in its topic are his version. */
async function openEditOf(db: Db, conversationId: string) {
  const [edit] = await db
    .select({ q: question })
    .from(question)
    .innerJoin(convTurn, eq(convTurn.id, question.entityId))
    .where(
      and(
        eq(question.kind, 'conv_edit'),
        isNull(question.answeredAt),
        eq(convTurn.conversationId, conversationId),
      ),
    )
    .orderBy(desc(question.askedAt))
    .limit(1)
  return edit?.q ?? null
}

/** The latest open card of a conversation (a draft, a reminder, a client of Boris's), with its turn. */
export async function openCardOf(db: Db, conversationId: string) {
  const [row] = await db
    .select({ card: task, turn: convTurn })
    .from(task)
    .innerJoin(convTurn, eq(convTurn.id, task.entityId))
    .where(
      and(
        eq(task.kind, 'conv_draft'),
        eq(task.state, 'open'),
        eq(convTurn.conversationId, conversationId),
      ),
    )
    .orderBy(desc(task.createdAt))
    .limit(1)
  return row ?? null
}

/**
 * Boris's words in a client's topic of the forum that answer no card and no question (docs/product/telegram-forum.md):
 * an instruction about this client. A command word works as on the card; while «Изменить» waits, the words are his
 * version; any other words are his text for the client, shown back with «Отправить», and only that press sends them.
 */
export async function onClientText(
  d: CommandDeps,
  m: { conversationId: string | null; text: string; voice: boolean; messageId?: number; at: Date },
): Promise<BorisReply | null> {
  const conv = m.conversationId ? await getConversation(d.db, m.conversationId) : null
  if (!conv) return COMMAND_TEXTS.noChatYet
  const c = parseCardReply(m.text)
  const edit = c ? null : await openEditOf(d.db, conv.id)
  if (edit)
    return onConvEdit(d, {
      question: edit,
      text: m.text,
      voice: m.voice,
      messageId: m.messageId,
      at: m.at,
    })
  const open = await openCardOf(d.db, conv.id)
  const live = !(await getSetting(d.db, 'conv.v1_writes'))
  switch (c?.cmd) {
    case 'take':
      await take(d.db, conv.id)
      return COMMAND_TEXTS.taken
    case 'return':
      await giveBack(d.db, conv.id, c.note)
      return COMMAND_TEXTS.returned
    case 'close':
      await close(d.db, conv.id, d.notifier)
      return COMMAND_TEXTS.closed
    case 'confirm': {
      // A typed «да» sends nothing: the card's own button does.
      if (!open || (live && !open.turn.text && open.turn.kind !== 'reminder'))
        return COMMAND_TEXTS.nothingToSend
      const action: TaskAction = live ? 'send' : 'good'
      return {
        text: live ? COMMAND_TEXTS.pressSend : COMMAND_TEXTS.pressGood,
        rows: [
          [
            {
              text: live ? CONV_TEXTS.buttons.send : CONV_TEXTS.buttons.good,
              callbackData: formatCallback(open.card.id, action),
            },
          ],
        ],
      }
    }
    case 'say':
      // A bare «ответь ей» asks Sara to write the answer: the chat in the topic does, when it is on.
      if (c.text === null && !(live && d.sendText && d.topicChat && !conv.closedAt))
        return COMMAND_TEXTS.askText
  }
  // The story of a call («созвонились, договорились, что пришлю КП до пятницы») is not a text for the client.
  if (!c && d.meetingResult) {
    const told = await d.meetingResult(conv, m.text, m.at)
    if (told) return told
  }
  // Plain words go to the chat in the topic: Sara rewrites the draft by them («напиши: …» stays his exact text).
  if (
    (!c || (c.cmd === 'say' && c.text === null)) &&
    live &&
    d.sendText &&
    d.topicChat &&
    !conv.closedAt
  ) {
    await d.topicChat.take({
      conversationId: conv.id,
      text: m.text,
      voice: m.voice,
      ...(m.messageId !== undefined && { messageRef: m.messageId }),
      at: m.at,
    })
    return null
  }
  const words = c?.cmd === 'say' && c.text ? c.text : m.text
  if (!live || !d.sendText) return say(d, conv.id, words, telegramKey(m.messageId))
  if (open && open.turn.kind !== 'say')
    return proposeSay(d, open.turn, words, { via: 'say', voice: m.voice, messageId: m.messageId })
  return proposeFreeSay(d, conv.id, words, { voice: m.voice, messageId: m.messageId })
}

/**
 * Boris's words for a client with no open card (nothing waits for an answer): kept in a row of their own and shown
 * back with «Отправить» and «Изменить». The press sends them against the chat as it was when he wrote, so a client
 * who wrote meanwhile is never answered over (CHAT_CHANGED).
 */
export async function proposeFreeSay(
  d: CommandDeps,
  conversationId: string,
  text: string,
  o: { voice?: boolean; messageId?: number; chat?: boolean },
): Promise<BorisReply> {
  const rowId =
    o.messageId !== undefined
      ? `conv-say:free:${conversationId}:tg:${o.messageId}`
      : `conv-say:free:${conversationId}:${newEventId()}`
  const expectLast = await lastSeen(d.db, conversationId)
  const taskId = newEventId()
  const made = await d.db.transaction(async (tx) => {
    const rows = await tx
      .insert(convTurn)
      .values({
        id: rowId,
        conversationId,
        kind: 'say',
        anchorMessageId: expectLast ?? '',
        state: 'decided',
        text,
        decision: 'say',
        understanding: {
          free: true,
          voice: o.voice ?? false,
          key: sayKey(o),
          expectLast,
          ...(o.chat && { chat: true }),
        },
        taskId,
      })
      .onConflictDoNothing()
      .returning({ id: convTurn.id })
    if (rows.length === 0) return false
    await tx.insert(task).values({
      id: taskId,
      kind: 'conv_say',
      entityKind: 'conv_turn',
      entityId: rowId,
      priority: 'P1',
    })
    return true
  })
  if (!made) return COMMAND_TEXTS.sayAsked
  const b = (label: string, action: TaskAction) => ({
    text: label,
    callbackData: formatCallback(taskId, action),
  })
  return {
    text: COMMAND_TEXTS.sayConfirm(text),
    rows: [[b(CONV_TEXTS.buttons.send, 'send'), b(CONV_TEXTS.buttons.edit, 'edit')]],
  }
}

/** A press under words with no card behind them: «Отправить» sends exactly them once, «Изменить» asks again. */
async function onFreeSayPress(
  d: CommandDeps,
  st: CardTask,
  say: typeof convTurn.$inferSelect,
  action: TaskAction,
): Promise<string> {
  const meta = (say.understanding ?? {}) as { key?: string | null; expectLast?: string | null }
  if (action === 'edit') {
    if (!(await closeCard(d.db, st.id, 'edit'))) return COMMAND_TEXTS.done
    return COMMAND_TEXTS.askFree
  }
  if (action !== 'send') return COMMAND_TEXTS.notUnderstood
  if (await getSetting(d.db, 'conv.v1_writes')) return COMMAND_TEXTS.shadowSend
  if (!d.sendText || !say.text) return COMMAND_TEXTS.noDraft
  const hold = await sendHold(d.db, say.conversationId, 'boris')
  if (hold) return holdText(hold)
  if (!(await closeCard(d.db, st.id, 'send'))) return COMMAND_TEXTS.done
  await journal(d.db, 'conv.said', say.conversationId, 'boris', { turn_id: say.id })
  return d.sendText(say.conversationId, say.text, 'boris', {
    expectLast: meta.expectLast ?? null,
    key: meta.key ?? `say:${st.id}`,
  })
}
