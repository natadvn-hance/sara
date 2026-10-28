import type { Db } from '../db/client'
import { TEXTS } from '../notify/cards'
import type { Transcriber } from '../notify/transcribe'
import {
  DRAFT_KINDS,
  type DraftAnswer,
  markAnswered,
  openQuestion,
  type QuestionKind,
  type QuestionRow,
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
  /** The words of the message it replies to, when it replies to one that has words. */
  replyToText?: string | null
  at: Date
}

/** Boris's words as they reach the Secretary (ADR-027), with the open questions they might answer. */
export type SecretaryWords = {
  text: string
  voice: boolean
  messageId?: number
  replyToText: string | null
  at: Date
  /** Sara's open questions this message came after without a reply: it may answer one, or ask for something else. */
  questions: QuestionRow[]
}

/** The answer to an open question, given the words that answer it. */
export type AnswerDeps = {
  db: Db
  onDraftText?(a: DraftAnswer): Promise<string>
  /** M4: Boris's version of a reply after «Изменить» on a conversation card. */
  onConvEdit?(a: DraftAnswer): Promise<BorisReply>
}

/**
 * Words that ask Sara for something rather than answer her: a request or a question word first, or a question mark
 * at the end. Such words after a «почему?» go to the Secretary, who tells a reason from a request (M7 design 10).
 */
const REQUEST_START =
  /^(?:(?:откликн|пропуст|постав|сним|выключ|включ|покаж|расскаж|напиш|перепиш|верн|закро|возьм|найд|провер|посмотр|объясн|отправ)\p{L}*|ответь|беру|пришли|дай|давай|что|как|какие|какой|какая|какую|сколько|скок|где|когда|кто|зачем|почему|есть|можно|сара)(?![\p{L}-])/iu

export function looksLikeRequest(text: string): boolean {
  const t = text.trim()
  return REQUEST_START.test(t) || /\?[\s)]*$/.test(t)
}

/** Boris's words as the answer to this question: a new bid text, his version of a client reply, or a reason. */
export async function answerQuestion(
  d: AnswerDeps,
  q: QuestionRow,
  a: { text: string; voice: boolean; messageId?: number; at: Date },
): Promise<BorisReply> {
  if ((DRAFT_KINDS as string[]).includes(q.kind))
    return d.onDraftText ? d.onDraftText({ question: q, ...a }) : TEXTS.notAnAnswer
  if (q.kind === 'conv_edit')
    return d.onConvEdit ? d.onConvEdit({ question: q, ...a }) : TEXTS.notAnAnswer
  const answered = await d.db.transaction((tx) => markAnswered(tx, q, a))
  return answered ? TEXTS.noted(a.text, await titleOf(d.db, q)) : TEXTS.notAnAnswer
}

/**
 * Boris's own words, typed or spoken. A reply to a card or to a question goes to it. An answer to the request after
 * «Изменить» (the new bid text) or for the price goes to `onDraftText`; any other answer is a reason. A message that
 * could be either (no reply, both kinds waiting) is stored nowhere: Sara asks which, naming the leads. Everything
 * else, and words that ask for something after a question without replying to it, go to the Secretary (ADR-027),
 * whose answer comes later as its own message (null here).
 */
export async function handleBorisMessage(
  d: {
    db: Db
    transcriber: Transcriber
    /** ADR-027: the Secretary takes the words; null: its answer comes on its own. Without it, only answers count. */
    onSecretary?(w: SecretaryWords): Promise<BorisReply | null>
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
  },
  m: BorisMessage,
): Promise<BorisReply | null> {
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
  const q = await openQuestion(d.db, { replyToMessageId: m.replyToMessageId, at: m.at })
  if (d.onSecretary) {
    const words = { ...a, replyToText: m.replyToText ?? null }
    if (!q) return d.onSecretary({ ...words, questions: [] })
    if (m.replyToMessageId === null && looksLikeRequest(text))
      return d.onSecretary({ ...words, questions: 'ambiguous' in q ? q.ambiguous : [q] })
  }
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
  return answerQuestion(d, q, a)
}
