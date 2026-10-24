import type { Db } from '../db/client'
import { TEXTS } from '../notify/cards'
import type { Transcriber } from '../notify/transcribe'
import { answerQuestion } from './questions'

export type BorisMessage = {
  text: string | null
  /** A voice message saved on disk, recognized here. */
  voicePath: string | null
  replyToMessageId: number | null
  at: Date
}

/** Boris's own words, typed or spoken: for now only answers to Sara's questions are understood. */
export async function handleBorisMessage(
  d: { db: Db; transcriber: Transcriber },
  m: BorisMessage,
): Promise<string> {
  let text = m.text?.trim() ?? ''
  if (m.voicePath) {
    const heard = await d.transcriber.transcribe(m.voicePath)
    if (!heard) return TEXTS.voiceFailed
    text = heard
  }
  if (!text) return TEXTS.notAnAnswer
  const r = await answerQuestion(d.db, {
    text,
    replyToMessageId: m.replyToMessageId,
    voice: m.voicePath !== null,
    at: m.at,
  })
  return r ? TEXTS.noted(text) : TEXTS.notAnAnswer
}
