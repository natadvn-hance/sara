import type { Db } from '../db/client'
import { TEXTS } from '../notify/cards'
import type { Transcriber } from '../notify/transcribe'
import {
  DRAFT_KINDS,
  type DraftAnswer,
  markAnswered,
  openQuestion,
  type QuestionKind,
  titleOf,
} from './questions'

/** The answer to Boris's message: a line, or a line with the buttons that belong to it (a press goes the usual way). */
export type BorisReply = string | { text: string; rows: { text: string; callbackData: string }[][] }

export type BorisMessage = {
  text: string | null
  /** A voice message saved on disk, recognized here. */
  voicePath: string | null
  replyToMessageId: number | null
  /** The message's number in Telegram: a repeat of the same update is the same message. */
  messageId?: number
  /** Written in a client's topic of the forum: the words are about this client (docs/product/telegram-forum.md). */
  client?: { conversationId: string | null; orderId: string | null }
  at: Date
}

/**
 * Boris's own words, typed or spoken: for now only answers to Sara's questions are understood. An answer to the
 * request after «Изменить» (the new bid text) or for the price goes to `onDraftText`; any other answer is a reason.
 * A message that could be either (no reply, both kinds waiting) is stored nowhere: Sara asks which, naming the leads.
 */
export async function handleBorisMessage(
  d: {
    db: Db
    transcriber: Transcriber
    onDraftText?(a: DraftAnswer): Promise<string>
    /** M4: a reply to a conversation card is a command; null when the message replies to something else. */
    onCardReply?(m: {
      replyToMessageId: number | null
      text: string
      voice: boolean
      messageId?: number
      at: Date
    }): Promise<BorisReply | null>
    /** M4: Boris's version of a reply after «Изменить» on a conversation card. */
    onConvEdit?(a: DraftAnswer): Promise<BorisReply>
    /** Words in a client's topic that answer no card and no question: an instruction about this client. */
    onClientText?(m: {
      conversationId: string | null
      text: string
      voice: boolean
      messageId?: number
      at: Date
    }): Promise<BorisReply>
  },
  m: BorisMessage,
): Promise<BorisReply> {
  let text = m.text?.trim() ?? ''
  if (m.voicePath) {
    const heard = await d.transcriber.transcribe(m.voicePath)
    if (!heard) return TEXTS.voiceFailed
    text = heard
  }
  if (!text) return TEXTS.notAnAnswer
  const a = { text, voice: m.voicePath !== null, messageId: m.messageId, at: m.at }
  const command = await d.onCardReply?.({
    replyToMessageId: m.replyToMessageId,
    text,
    voice: a.voice,
    messageId: m.messageId,
    at: m.at,
  })
  if (command) return command
  // In a client's topic an answer to a question is a reply to it; any other words are about the client.
  if (m.client && d.onClientText) {
    const asked =
      m.replyToMessageId === null
        ? null
        : await openQuestion(d.db, { replyToMessageId: m.replyToMessageId, at: m.at })
    if (!asked || 'ambiguous' in asked)
      return d.onClientText({ conversationId: m.client.conversationId, ...a })
  }
  const q = await openQuestion(d.db, { replyToMessageId: m.replyToMessageId, at: m.at })
  if (!q) return TEXTS.notAnAnswer
  if ('ambiguous' in q) {
    // A new bid text or a reason: stored on a guess, either would end up on the wrong lead.
    // Two requests for the same lead are one line.
    const once = [...new Map(q.ambiguous.map((w) => [`${w.kind}:${w.entityId}`, w])).values()]
    const waiting = await Promise.all(
      once.map(async (w) => {
        const line = TEXTS.waitingFor[w.kind as QuestionKind]
        return line ? line(await titleOf(d.db, w)) : 'мой вопрос'
      }),
    )
    return TEXTS.whichQuestion(waiting)
  }
  if ((DRAFT_KINDS as string[]).includes(q.kind))
    return d.onDraftText ? d.onDraftText({ question: q, ...a }) : TEXTS.notAnAnswer
  if (q.kind === 'conv_edit')
    return d.onConvEdit ? d.onConvEdit({ question: q, ...a }) : TEXTS.notAnAnswer
  const answered = await d.db.transaction((tx) => markAnswered(tx, q, a))
  return answered ? TEXTS.noted(text, await titleOf(d.db, q)) : TEXTS.notAnAnswer
}
