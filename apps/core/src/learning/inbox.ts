import type { Db } from '../db/client'
import { TEXTS } from '../notify/cards'
import type { Transcriber } from '../notify/transcribe'
import { type DraftAnswer, markAnswered, openQuestion } from './questions'

export type BorisMessage = {
  text: string | null
  /** A voice message saved on disk, recognized here. */
  voicePath: string | null
  replyToMessageId: number | null
  at: Date
}

/**
 * Boris's own words, typed or spoken: for now only answers to Sara's questions are understood. An answer to the
 * request after «Изменить» is the new bid text and goes to `onDraftText`; any other answer is a reason.
 */
export async function handleBorisMessage(
  d: { db: Db; transcriber: Transcriber; onDraftText?(a: DraftAnswer): Promise<string> },
  m: BorisMessage,
): Promise<string> {
  let text = m.text?.trim() ?? ''
  if (m.voicePath) {
    const heard = await d.transcriber.transcribe(m.voicePath)
    if (!heard) return TEXTS.voiceFailed
    text = heard
  }
  if (!text) return TEXTS.notAnAnswer
  const a = { text, voice: m.voicePath !== null, at: m.at }
  const q = await openQuestion(d.db, { replyToMessageId: m.replyToMessageId, at: m.at })
  if (!q) return TEXTS.notAnAnswer
  if (q.kind === 'edit_draft')
    return d.onDraftText ? d.onDraftText({ question: q, ...a }) : TEXTS.notAnAnswer
  const answered = await d.db.transaction((tx) => markAnswered(tx, q, a))
  return answered ? TEXTS.noted(text) : TEXTS.notAnAnswer
}
