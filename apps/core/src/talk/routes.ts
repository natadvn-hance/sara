import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newEventId } from '@sara/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth/session'
import type { BorisMessage, BorisReply } from '../learning/inbox'
import { TEXTS } from '../notify/cards'
import type { ChatLine } from '../secretary/store'
import type { TalkAnswers } from './answers'
import type { Voice } from './voice'

export const TALK_TEXTS = {
  gone: 'Ответ потерялся: Сара перезапускалась. Скажи ещё раз.',
  noVoice: 'Голос сейчас недоступен, ответ только текстом.',
  empty: 'Не услышала слов. Скажи ещё раз.',
} as const

/** A recording of up to a few minutes; anything bigger is not a question to Sara. */
const AUDIO_LIMIT = 15 * 1024 * 1024
/** How long one ask for the answer waits: shorter than the proxies' and the phone's patience. */
const WAIT_MS = 25_000

const TypedWords = z.object({ text: z.string().trim().min(1).max(4000) })
const SpeakBody = z.object({ text: z.string().trim().min(1).max(4000) })

const EXT: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}

/** An answer that came at once, as the app shows it: buttons it had are in Telegram. */
const shown = (r: BorisReply) =>
  typeof r === 'string' ? { text: r, buttons: false } : { text: r.text, buttons: r.rows.length > 0 }

/**
 * The voice app's addresses (ADR-028), all behind the pult's sign-in, checked before the body is read. Boris's voice is
 * heard here, his words take the bot's way (`handle`, the same `handleBorisMessage`), and an answer of the Secretary is
 * waited for under the talk's id.
 */
export function registerTalkRoutes(
  app: FastifyInstance,
  d: {
    transcribe(path: string): Promise<string | null>
    handle(m: BorisMessage): Promise<BorisReply | null>
    answers: TalkAnswers
    voice: Voice
    history(): Promise<ChatLine[]>
    workDir: string
    waitMs?: number
  },
): void {
  app.register(async (scoped) => {
    scoped.addHook('onRequest', requireSession)
    scoped.addContentTypeParser(
      /^(?:audio\/|video\/mp4|application\/octet-stream)/,
      { parseAs: 'buffer', bodyLimit: AUDIO_LIMIT },
      (_req, body, done) => done(null, body),
    )

    scoped.post('/api/talk', async (req, reply) => {
      d.voice.warm()
      let text: string
      const spoken = Buffer.isBuffer(req.body)
      if (Buffer.isBuffer(req.body)) {
        const type =
          String(req.headers['content-type'] ?? '')
            .split(';')[0]
            ?.trim() ?? ''
        await mkdir(d.workDir, { recursive: true })
        const path = join(d.workDir, `talk-${newEventId()}.${EXT[type] ?? 'bin'}`)
        try {
          await writeFile(path, req.body)
          const heard = await d.transcribe(path)
          if (!heard)
            return { heard: null, talk: null, reply: { text: TEXTS.voiceFailed, buttons: false } }
          text = heard
        } finally {
          await rm(path, { force: true })
        }
      } else {
        const typed = TypedWords.safeParse(req.body ?? {})
        if (!typed.success) return reply.code(400).send({ error: TALK_TEXTS.empty })
        text = typed.data.text
      }
      const talk = d.answers.open()
      const r = await d.handle({
        text,
        voicePath: null,
        spoken,
        replyToMessageId: null,
        talk,
        at: new Date(),
      })
      return r === null
        ? { heard: text, talk, reply: null }
        : { heard: text, talk: null, reply: shown(r) }
    })

    scoped.get('/api/talk/history', async () => ({ lines: await d.history() }))

    scoped.get('/api/talk/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!z.uuid().safeParse(id).success)
        return reply.code(404).send({ state: 'gone', error: TALK_TEXTS.gone })
      const w = await d.answers.wait(id, d.waitMs ?? WAIT_MS)
      if (w.state === 'gone') return reply.code(404).send({ state: 'gone', error: TALK_TEXTS.gone })
      return w.state === 'done' ? { state: 'done', ...w.answer } : { state: 'waiting' }
    })

    scoped.post('/api/talk/speak', async (req, reply) => {
      const body = SpeakBody.safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: TALK_TEXTS.empty })
      const audio = await d.voice.speak(body.data.text)
      if (!audio) return reply.code(503).send({ error: TALK_TEXTS.noVoice })
      return reply.type('audio/mpeg').header('cache-control', 'no-store').send(audio)
    })

    scoped.post('/api/talk/warm', async (_req, reply) => {
      d.voice.warm()
      return reply.code(204).send()
    })
  })
}
