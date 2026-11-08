import { timingSafeEqual } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newEventId } from '@sara/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth/session'
import type { BorisMessage, BorisReply } from '../learning/inbox'
import { TEXTS } from '../notify/cards'
import type { ChatLine } from '../secretary/store'
import { AGENT_IDS, AGENTS, type Agent, switchTo } from './agents'
import type { TalkAnswers } from './answers'
import type { LoraLink } from './lora'
import type { Voice } from './voice'

export const TALK_TEXTS = {
  gone: 'Ответ потерялся: Сара перезапускалась. Скажи ещё раз.',
  noVoice: 'Голос сейчас недоступен, ответ только текстом.',
  empty: 'Не услышала слов. Скажи ещё раз.',
  loraOff: 'Лора ещё не подключена к приложению. Позови Сару или напиши Лоре в Telegram.',
  loraAway: 'Лора сейчас не на связи в приложении. Напиши ей в Telegram или позови Сару.',
} as const

/** Where Lora's channel takes Boris's words and gives her answers (ADR-028); her own key guards it. */
export const LORA_APP_PATH = '/api/lora/app'

/** A recording of up to a few minutes; anything bigger is not a question to Sara. */
const AUDIO_LIMIT = 15 * 1024 * 1024
/** How long one ask for the answer waits: shorter than the proxies' and the phone's patience. */
const WAIT_MS = 25_000

const AgentId = z.enum(AGENT_IDS)
const TypedWords = z.object({ text: z.string().trim().min(1).max(4000) })
const SpeakBody = z.object({ text: z.string().trim().min(1).max(4000), agent: AgentId.optional() })
const AgentQuery = z.object({ agent: AgentId.optional(), talk: z.uuid().optional() })
const LoraReply = z.object({ talk: z.uuid(), text: z.string().trim().min(1).max(4000) })

/**
 * One line a request in the log (Boris 08.11: «Нет связи» could not be told apart): the path without the talk's id,
 * the agent, the code, the time, the size, an error's own words. Never the words said.
 */
function journal(scope: FastifyInstance): void {
  scope.addHook('onError', async (req, _reply, err) => {
    ;(req as { talkError?: string }).talkError = err.message.slice(0, 200)
  })
  scope.addHook('onResponse', async (req, reply) => {
    const path = req.url.split('?')[0]?.replace(/[0-9a-f-]{36}/, ':id')
    const agent = /[?&]agent=(\w+)/.exec(req.url)?.[1] ?? '-'
    const size = req.headers['content-length'] ?? '0'
    const error = (req as { talkError?: string }).talkError
    console.log(
      `talk ${req.method} ${path} agent=${agent} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms body=${size}${error ? ` error=${error}` : ''}`,
    )
  })
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

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
    /** Lora's side of the app: her channel takes the words from here. */
    lora: LoraLink
    /** Lora's own key (SARA_LORA_TOKEN); unset, Lora is not in the app. */
    loraToken: string | undefined
    workDir: string
    waitMs?: number
  },
): void {
  /** Lora's channel, from her session on the server: by her key only, never by the pult's sign-in. */
  app.register(async (lora) => {
    journal(lora)
    lora.addHook('onRequest', async (req, reply) => {
      if (!d.loraToken) return reply.code(503).send({ error: 'the app channel is off' })
      const given = req.headers['x-sara-lora-token']
      if (typeof given !== 'string' || !same(given, d.loraToken))
        return reply.code(401).send({ error: 'unauthorized' })
    })
    lora.get(`${LORA_APP_PATH}/next`, async (_req, reply) => {
      // The channel may cut its ask: its word must not go to a closed socket.
      const gone = new AbortController()
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) gone.abort()
      })
      const w = await d.lora.next(d.waitMs ?? WAIT_MS, gone.signal)
      return w ?? reply.code(204).send()
    })
    lora.post(`${LORA_APP_PATH}/reply`, async (req, reply) => {
      const body = LoraReply.safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: 'talk and text are needed' })
      d.lora.reply(body.data.talk, body.data.text)
      const waiting = d.answers.pending(body.data.talk)
      d.answers.give([body.data.talk], { text: body.data.text, cards: 0 })
      return { ok: true, waiting }
    })
  })

  app.register(async (scoped) => {
    journal(scoped)
    scoped.addHook('onRequest', requireSession)
    scoped.addContentTypeParser(
      /^(?:audio\/|video\/mp4|application\/octet-stream)/,
      { parseAs: 'buffer', bodyLimit: AUDIO_LIMIT },
      (_req, body, done) => done(null, body),
    )

    scoped.post('/api/talk', async (req, reply) => {
      d.voice.warm()
      const asked = AgentQuery.safeParse(req.query ?? {})
      if (!asked.success) return reply.code(400).send({ error: TALK_TEXTS.empty })
      let agent: Agent = asked.data.agent ?? 'sara'
      // The phone names the talk itself: when the reply is lost on a bad line, it asks for the answer by this id.
      const talk = d.answers.open(asked.data.talk)
      const atOnce = (
        heard: string | null,
        replyText: string,
        o: { buttons?: boolean; switch?: Agent } = {},
      ) => {
        d.answers.give([talk], {
          text: replyText,
          cards: o.buttons ? 1 : 0,
          heard,
          ...(o.switch && { switch: o.switch }),
        })
        return {
          heard,
          talk: null,
          ...(o.switch && { switch: o.switch }),
          reply: { text: replyText, buttons: o.buttons ?? false },
        }
      }
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
          if (!heard) return atOnce(null, TEXTS.voiceFailed)
          text = heard
        } finally {
          await rm(path, { force: true })
        }
      } else {
        const typed = TypedWords.safeParse(req.body ?? {})
        if (!typed.success) return reply.code(400).send({ error: TALK_TEXTS.empty })
        text = typed.data.text
      }
      const heard = text
      // «Позови Сару»: the other one comes and greets; a question after her name goes to her at once.
      const call = switchTo(text, agent)
      if (call) {
        agent = call.agent
        if (!call.rest) return atOnce(heard, AGENTS[agent].greeting, { switch: agent })
        text = call.rest
      }
      const switched = call ? { switch: agent } : {}
      if (agent === 'lora') {
        if (!d.loraToken) return atOnce(heard, TALK_TEXTS.loraOff, switched)
        if (!d.lora.connected()) return atOnce(heard, TALK_TEXTS.loraAway, switched)
        d.lora.push({ talk, text, voice: spoken, at: new Date().toISOString() })
        return { heard, talk, ...switched, reply: null }
      }
      const r = await d.handle({
        text,
        voicePath: null,
        spoken,
        replyToMessageId: null,
        talk,
        at: new Date(),
      })
      if (r === null) return { heard, talk, ...switched, reply: null }
      const s = shown(r)
      return atOnce(heard, s.text, { buttons: s.buttons, ...switched })
    })

    scoped.get('/api/talk/history', async (req, reply) => {
      const asked = AgentQuery.safeParse(req.query ?? {})
      if (!asked.success) return reply.code(400).send({ error: TALK_TEXTS.empty })
      if (asked.data.agent === 'lora') return { lines: d.lora.history() }
      return { lines: await d.history() }
    })

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
      const audio = await d.voice.speak(body.data.text, AGENTS[body.data.agent ?? 'sara'].speaker)
      if (!audio) return reply.code(503).send({ error: TALK_TEXTS.noVoice })
      return reply.type('audio/mpeg').header('cache-control', 'no-store').send(audio)
    })

    scoped.post('/api/talk/warm', async (_req, reply) => {
      d.voice.warm()
      return reply.code(204).send()
    })
  })
}
