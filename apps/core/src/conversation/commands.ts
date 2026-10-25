import { type Actor, newEventId, type TaskAction } from '@sara/shared'
import { and, desc, eq, isNull, like } from 'drizzle-orm'
import type { Db } from '../db/client'
import { chatMessage, convTurn, outbox, question, task } from '../db/schema'
import { TransitionError, transition } from '../domain/deal'
import { redact } from '../gateway/redact'
import { appendEvent } from '../journal/journal'
import type { QuestionRow } from '../learning/questions'
import { proposeMind } from '../mind/proposals'
import type { Notifier } from '../notify/notifier'
import { getSetting } from '../settings/store'
import { clientNames } from './dossier'
import { SEND_TEXTS, type SendOptions } from './outbox'
import { getConversation, updateConversation } from './store'

export type CommandDeps = {
  db: Db
  notifier: Pick<Notifier, 'sendText'>
  /** After the switch: a text goes to the client through the outbox (part C6); the answer is for Boris. */
  sendText?(
    conversationId: string,
    text: string,
    author: 'sara' | 'boris',
    o?: SendOptions,
  ): Promise<string>
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
    'Не поняла. Ответь на карточку словами: «беру сам», «верни», «напиши: …» или «закрой».',
  noDraft: 'В этой карточке нет текста для клиента.',
  alreadySent: 'Ответ уже ушёл клиенту или стоит в очереди. Второй раз не отправляю.',
  sendUncertain:
    'Не уверена, что прошлая отправка дошла. Проверь чат в Профи.ру, повторно не отправляю.',
  answeredYourself:
    'Ты уже ответил сам: в чате есть твоё сообщение после слов клиента. Черновик не отправляю.',
  stale: 'Черновик устарел: клиент успел дописать. Текст не ушёл, посмотри новые сообщения.',
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

/** Closes the conversation's open cards: one decision answers them all. */
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

/** «Закрыть» (FR-CONV-11): no turns, no reminders; the deal, when the new Sara made the bid, is lost. */
export async function close(db: Db, conversationId: string): Promise<void> {
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
}

/** The latest turn of a conversation: Boris's words are kept beside its draft. */
async function latestTurn(db: Db, conversationId: string) {
  const [t] = await db
    .select()
    .from(convTurn)
    .where(eq(convTurn.conversationId, conversationId))
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
export async function say(d: CommandDeps, conversationId: string, text: string): Promise<string> {
  const t = await latestTurn(d.db, conversationId)
  if (t) {
    await d.db.update(convTurn).set({ borisText: text }).where(eq(convTurn.id, t.id))
    await proposeBorisWords(d.db, t.id, conversationId, text)
  }
  await journal(d.db, 'conv.said', conversationId, 'boris')
  if ((await getSetting(d.db, 'conv.v1_writes')) || !d.sendText) return COMMAND_TEXTS.shadowSay
  return d.sendText(conversationId, text, 'boris')
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
  const own = await db
    .select({ state: outbox.state })
    .from(outbox)
    .where(and(eq(outbox.kind, 'message'), like(outbox.idempotencyKey, `msg:${turn.id}:%`)))
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

/** A press on a conversation card (C5 actions: good, edit, send, take, return, close). */
export async function onConvPress(
  d: CommandDeps,
  p: { taskId: string; action: TaskAction },
): Promise<string> {
  const t = await cardTaskOf(d.db, p.taskId)
  const [turn] = t ? await d.db.select().from(convTurn).where(eq(convTurn.id, t.entityId)) : []
  if (!t || !turn) return COMMAND_TEXTS.done
  const conversationId = turn.conversationId
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
      await close(d.db, conversationId)
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
      const refusal = await sendRefusal(d.db, turn)
      if (refusal) return refusal
      // The press is taken once; the service is told the last client message this draft answers, so a chat that
      // moved on is refused there (CHAT_CHANGED) and not answered over.
      const claimed = await closeCard(d.db, t.id, 'send')
      if (!claimed) return COMMAND_TEXTS.done
      const covered = ((turn.messageIds as string[] | null) ?? []).at(-1)
      const answer = await d.sendText(conversationId, turn.text, 'sara', {
        expectLast: covered ?? undefined,
      })
      if (answer !== SEND_TEXTS.changed) return answer
      await d.db.update(task).set({ resolution: 'stale' }).where(eq(task.id, t.id))
      return COMMAND_TEXTS.stale
    }
    default:
      return COMMAND_TEXTS.notUnderstood
  }
}

/** «Изменить»: a question whose answer is Boris's version of the reply. */
async function startEdit(d: CommandDeps, turnId: string): Promise<void> {
  const id = newEventId()
  const now = new Date()
  await d.db
    .insert(question)
    .values({ id, kind: 'conv_edit', entityId: turnId, askedAt: now.toISOString() })
  const m = await d.notifier.sendText(COMMAND_TEXTS.askEdit)
  await d.db.update(question).set({ telegramMessageId: m.messageId }).where(eq(question.id, id))
}

/** Boris's version after «Изменить»: kept beside the draft (in shadow), sent as his text after the switch. */
export async function onConvEdit(
  d: CommandDeps,
  a: { question: QuestionRow; text: string; voice: boolean; at: Date },
): Promise<string> {
  await d.db
    .update(question)
    .set({ answeredAt: a.at.toISOString(), answer: a.text })
    .where(and(eq(question.id, a.question.id), isNull(question.answeredAt)))
  const [turn] = await d.db.select().from(convTurn).where(eq(convTurn.id, a.question.entityId))
  if (!turn) return COMMAND_TEXTS.done
  await d.db.update(convTurn).set({ borisText: a.text }).where(eq(convTurn.id, turn.id))
  await proposeBorisWords(d.db, turn.id, turn.conversationId, a.text)
  await journal(d.db, 'conv.draft_edited', turn.conversationId, 'boris', {
    turn_id: turn.id,
    voice: a.voice,
  })
  if ((await getSetting(d.db, 'conv.v1_writes')) || !d.sendText) return COMMAND_TEXTS.editKept
  return d.sendText(turn.conversationId, a.text, 'boris')
}

export type CardCommand =
  | { cmd: 'take' }
  | { cmd: 'return'; note: string | null }
  | { cmd: 'say'; text: string }
  | { cmd: 'close' }
  | { cmd: 'good' }

/** Boris's words in reply to a card, read as a command; anything else is not guessed (FR-NOTIF-1). */
export function parseCardReply(text: string): CardCommand | null {
  const t = text.trim()
  if (/^(беру сам|я сам|возьму|беру)(?!\p{L})/iu.test(t)) return { cmd: 'take' }
  const back = /^(?:верни|вернуть)(?!\p{L})(?:\s+саре)?\s*[:,.-]?\s*(.*)$/isu.exec(t)
  if (back) return { cmd: 'return', note: back[1]?.trim() || null }
  const write =
    /^(?:напиши|отправь|ответь)(?:\s+(?:ей|ему|клиенту|клиентке))?\s*[:,-]?\s*(.+)$/is.exec(t)
  if (write?.[1]?.trim()) return { cmd: 'say', text: write[1].trim() }
  if (/^(закрой|закрыть|закрываем)(?!\p{L})/iu.test(t)) return { cmd: 'close' }
  if (/^(да|ок|окей|хорошо|годится|норм)(?!\p{L})/iu.test(t)) return { cmd: 'good' }
  return null
}

/** A reply to a conversation card: null when it is not a reply to one (the message is someone else's business). */
export async function onConvReply(
  d: CommandDeps,
  m: { replyToMessageId: number | null; text: string; voice?: boolean; at: Date },
): Promise<string | null> {
  if (m.replyToMessageId === null) return null
  const [t] = await d.db
    .select()
    .from(task)
    .where(and(eq(task.telegramMessageId, m.replyToMessageId), eq(task.kind, 'conv_draft')))
  const [turn] = t ? await d.db.select().from(convTurn).where(eq(convTurn.id, t.entityId)) : []
  if (!t || !turn) return null
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
      return onConvEdit(d, { question: edit, text: m.text, voice: m.voice ?? false, at: m.at })
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
      return say(d, turn.conversationId, c.text)
    case 'close':
      await close(d.db, turn.conversationId)
      return COMMAND_TEXTS.closed
    case 'good':
      return onConvPress(d, { taskId: t.id, action: 'good' })
  }
}
