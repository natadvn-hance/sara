import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startSession } from '../../src/auth/session'
import type { BorisMessage, BorisReply } from '../../src/learning/inbox'
import { TEXTS } from '../../src/notify/cards'
import { createTalkAnswers, type TalkAnswers } from '../../src/talk/answers'
import { registerTalkRoutes, TALK_TEXTS } from '../../src/talk/routes'

let app: FastifyInstance
let answers: TalkAnswers
let handled: BorisMessage[]
let heardFiles: { path: string; bytes: string }[]
let heard: string | null
let replyOf: (m: BorisMessage) => BorisReply | null
let work: string
let session: string

beforeEach(async () => {
  answers = createTalkAnswers()
  handled = []
  heardFiles = []
  heard = 'что в очереди'
  replyOf = () => null
  work = await mkdtemp(join(tmpdir(), 'talk-'))
  app = Fastify()
  await app.register(cookie, { secret: 'test-secret' })
  app.get('/test/login', async (_req, reply) => {
    startSession(reply, false)
    return { ok: true }
  })
  registerTalkRoutes(app, {
    transcribe: async (path) => {
      heardFiles.push({ path, bytes: readFileSync(path, 'utf8') })
      return heard
    },
    handle: async (m) => {
      handled.push(m)
      return replyOf(m)
    },
    answers,
    voice: {
      warm: () => {},
      speak: async (text) => (text.includes('нечего') ? null : Buffer.from(`mp3:${text}`)),
    },
    history: async () => [{ author: 'sara', text: 'Привет', at: '2026-11-07T10:00:00.000Z' }],
    workDir: work,
    waitMs: 50,
  })
  const r = await app.inject({ url: '/test/login' })
  session = String(r.headers['set-cookie']).split(';')[0] ?? ''
})
afterEach(() => app.close())

const audio = (headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/talk',
    headers: { 'content-type': 'audio/mp4', ...headers },
    payload: Buffer.from('fake m4a'),
  })

describe('the voice app: only Boris gets in', () => {
  it('FR-NOTIF-5: without the pult sign-in every address of the app answers 401 and nothing is heard', async () => {
    const calls = [
      audio(),
      app.inject({ method: 'POST', url: '/api/talk', payload: { text: 'привет' } }),
      app.inject({ url: '/api/talk/history' }),
      app.inject({ url: '/api/talk/0199a000-0000-7000-8000-000000000001' }),
      app.inject({ method: 'POST', url: '/api/talk/speak', payload: { text: 'привет' } }),
      app.inject({ method: 'POST', url: '/api/talk/warm' }),
    ]
    for (const r of await Promise.all(calls)) expect(r.statusCode).toBe(401)
    const forged = await audio({ cookie: 'sara_session=owner:1' })
    expect(forged.statusCode).toBe(401)
    expect(handled).toEqual([])
    expect(heardFiles).toEqual([])
  })
})

describe('the voice app: Boris speaks, Sara answers', () => {
  it("FR-NOTIF-5: a voice is heard on the server, goes the bot's way and its answer is waited for", async () => {
    const r = await audio({ cookie: session })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body).toMatchObject({ heard: 'что в очереди', reply: null })
    expect(typeof body.talk).toBe('string')
    // The recording was read and is gone from the disk.
    expect(heardFiles.map((f) => f.bytes)).toEqual(['fake m4a'])
    expect(existsSync(heardFiles[0]?.path ?? '')).toBe(false)
    expect(await readdir(work)).toEqual([])
    expect(handled).toEqual([
      expect.objectContaining({
        text: 'что в очереди',
        voicePath: null,
        spoken: true,
        replyToMessageId: null,
        talk: body.talk,
      }),
    ])
    const waiting = await app.inject({
      url: `/api/talk/${body.talk}`,
      headers: { cookie: session },
    })
    expect(waiting.json()).toEqual({ state: 'waiting' })
    answers.give([body.talk], { text: 'Две заявки', cards: 1 })
    const done = await app.inject({ url: `/api/talk/${body.talk}`, headers: { cookie: session } })
    expect(done.json()).toEqual({ state: 'done', text: 'Две заявки', cards: 1 })
  })

  it("FR-NOTIF-5: an answer to Sara's question comes at once; typed words go the same way", async () => {
    replyOf = (m) => (m.text === 'дорого' ? TEXTS.noted('дорого', 'Сайт для кофейни') : null)
    const r = await app.inject({
      method: 'POST',
      url: '/api/talk',
      headers: { cookie: session },
      payload: { text: 'дорого' },
    })
    expect(r.json()).toEqual({
      heard: 'дорого',
      talk: null,
      reply: { text: TEXTS.noted('дорого', 'Сайт для кофейни'), buttons: false },
    })
    expect(handled[0]).toMatchObject({ text: 'дорого', spoken: false })
    replyOf = () => ({ text: 'Какой из двух?', rows: [[{ text: 'Первый', callbackData: 'x' }]] })
    const withButtons = await app.inject({
      method: 'POST',
      url: '/api/talk',
      headers: { cookie: session },
      payload: { text: 'этот' },
    })
    expect(withButtons.json().reply).toEqual({ text: 'Какой из двух?', buttons: true })
  })

  it('FR-NOTIF-5: a voice that is not made out is said so, and goes nowhere', async () => {
    heard = null
    const r = await audio({ cookie: session })
    expect(r.json()).toEqual({
      heard: null,
      talk: null,
      reply: { text: TEXTS.voiceFailed, buttons: false },
    })
    expect(handled).toEqual([])
  })

  it('FR-NOTIF-5: an answer lost to a restart is said so', async () => {
    const r = await app.inject({
      url: '/api/talk/0199a000-0000-7000-8000-000000000001',
      headers: { cookie: session },
    })
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ state: 'gone', error: TALK_TEXTS.gone })
    const bad = await app.inject({ url: '/api/talk/not-an-id', headers: { cookie: session } })
    expect(bad.statusCode).toBe(404)
  })

  it("FR-NOTIF-5: Sara's words come back in her voice, and the chat so far is shown", async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/talk/speak',
      headers: { cookie: session },
      payload: { text: 'Две заявки' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toBe('audio/mpeg')
    expect(r.body).toBe('mp3:Две заявки')
    const none = await app.inject({
      method: 'POST',
      url: '/api/talk/speak',
      headers: { cookie: session },
      payload: { text: 'нечего' },
    })
    expect(none.statusCode).toBe(503)
    const h = await app.inject({ url: '/api/talk/history', headers: { cookie: session } })
    expect(h.json()).toEqual({
      lines: [{ author: 'sara', text: 'Привет', at: '2026-11-07T10:00:00.000Z' }],
    })
  })
})
