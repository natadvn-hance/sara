import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSession } from '../../src/auth/session'
import type { BorisMessage, BorisReply } from '../../src/learning/inbox'
import { TEXTS } from '../../src/notify/cards'
import { AGENTS } from '../../src/talk/agents'
import { createTalkAnswers, type TalkAnswers } from '../../src/talk/answers'
import { createLoraLink, type LoraLink } from '../../src/talk/lora'
import { LORA_APP_PATH, registerTalkRoutes, TALK_TEXTS } from '../../src/talk/routes'

let app: FastifyInstance
let answers: TalkAnswers
let handled: BorisMessage[]
let heardFiles: { path: string; bytes: string }[]
let heard: string | null
let replyOf: (m: BorisMessage) => BorisReply | null
let work: string
let session: string
let lora: LoraLink
/** What went to the chat in Telegram: his words from the app and Sara's immediate answer. */
let mirrored: { words: string; reply: BorisReply }[]
let mirrorFails: boolean
/** The speakers the voice was asked to warm: undefined is «both of Sara's». */
let warmed: (string | undefined)[]

beforeEach(async () => {
  answers = createTalkAnswers()
  lora = createLoraLink()
  handled = []
  mirrored = []
  mirrorFails = false
  warmed = []
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
      warm: (speaker) => {
        warmed.push(speaker)
      },
      speak: async (text, speaker) =>
        text.includes('нечего') ? null : Buffer.from(`mp3:${speaker ?? 'xenia'}:${text}`),
    },
    history: async () => [{ author: 'sara', text: 'Привет', at: '2026-11-07T10:00:00.000Z' }],
    lora,
    loraToken: 'lora-key',
    workDir: work,
    waitMs: 50,
    mirror: async (words, reply) => {
      if (mirrorFails) throw new Error('telegram down')
      mirrored.push({ words, reply })
    },
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
    // One system with the chat (Boris, 09.11): his words and her answer, buttons and all, are in Telegram too.
    await vi.waitFor(() => expect(mirrored).toHaveLength(2))
    expect(mirrored).toEqual([
      { words: 'дорого', reply: TEXTS.noted('дорого', 'Сайт для кофейни') },
      {
        words: 'этот',
        reply: { text: 'Какой из двух?', rows: [[{ text: 'Первый', callbackData: 'x' }]] },
      },
    ])
  })

  it('FR-NOTIF-5: a chat that fails does not cost the app its answer', async () => {
    mirrorFails = true
    replyOf = () => 'Записала'
    const r = await app.inject({
      method: 'POST',
      url: '/api/talk',
      headers: { cookie: session },
      payload: { text: 'дорого' },
    })
    expect(r.json().reply).toEqual({ text: 'Записала', buttons: false })
  })

  it('FR-NOTIF-5: words for the Secretary are not copied here: the Secretary shows them with her answer', async () => {
    replyOf = () => null
    await app.inject({
      method: 'POST',
      url: '/api/talk',
      headers: { cookie: session },
      payload: { text: 'что в очереди' },
    })
    expect(mirrored).toEqual([])
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
    expect(r.body).toBe('mp3:xenia:Две заявки')
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

describe('the voice app: the voice is warmed before the first phrase', () => {
  it("FR-NOTIF-5: /api/talk/warm warms the voice of the agent named, and both of Sara's when none is", async () => {
    const warm = (query: string) =>
      app.inject({ method: 'POST', url: `/api/talk/warm${query}`, headers: { cookie: session } })
    expect((await warm('?agent=lora')).statusCode).toBe(204)
    expect((await warm('?agent=sara')).statusCode).toBe(204)
    expect((await warm('')).statusCode).toBe(204)
    expect(warmed).toEqual([AGENTS.lora.speaker, AGENTS.sara.speaker, undefined])
    expect(warmed).toEqual(['baya', 'xenia', undefined])
  })

  it('FR-NOTIF-5: an agent nobody knows is refused and warms nothing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/talk/warm?agent=nobody',
      headers: { cookie: session },
    })
    expect(r.statusCode).toBe(400)
    expect(warmed).toEqual([])
  })

  it('FR-NOTIF-5: a voice sent to /api/talk warms the voice of the agent it goes to', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/talk?agent=lora',
      headers: { cookie: session, 'content-type': 'audio/mp4' },
      payload: Buffer.from('fake m4a'),
    })
    await app.inject({
      method: 'POST',
      url: '/api/talk',
      headers: { cookie: session },
      payload: { text: 'привет' },
    })
    expect(warmed).toEqual(['baya', undefined])
  })
})

describe('the voice app: Lora by default, Sara on call', () => {
  const lora_ = (
    path: string,
    o: { method?: 'GET' | 'POST'; key?: string; payload?: object } = {},
  ) =>
    app.inject({
      method: o.method ?? 'GET',
      url: `${LORA_APP_PATH}${path}`,
      headers: o.key === undefined ? {} : { 'x-sara-lora-token': o.key },
      ...(o.payload && { payload: o.payload }),
    })
  const say = (text: string, agent: 'lora' | 'sara') =>
    app.inject({
      method: 'POST',
      url: `/api/talk?agent=${agent}`,
      headers: { cookie: session },
      payload: { text },
    })

  it("FR-NOTIF-5: Lora's channel gets in by her key only, never by the pult's sign-in", async () => {
    expect((await lora_('/next')).statusCode).toBe(401)
    expect((await lora_('/next', { key: 'wrong' })).statusCode).toBe(401)
    const withCookie = await app.inject({
      url: `${LORA_APP_PATH}/next`,
      headers: { cookie: session },
    })
    expect(withCookie.statusCode).toBe(401)
    expect((await lora_('/next', { key: 'lora-key' })).statusCode).toBe(204)
  })

  it('FR-NOTIF-5: words to Lora reach her channel, and her reply reaches the app in her voice', async () => {
    await lora_('/next', { key: 'lora-key' })
    const sent = await say('что у меня завтра', 'lora')
    const body = sent.json()
    expect(body).toMatchObject({ heard: 'что у меня завтра', reply: null })
    const taken = await lora_('/next', { key: 'lora-key' })
    expect(taken.json()).toMatchObject({ talk: body.talk, text: 'что у меня завтра', voice: false })
    // Words to Lora never take Sara's way.
    expect(handled).toEqual([])
    const r = await lora_('/reply', {
      method: 'POST',
      key: 'lora-key',
      payload: { talk: body.talk, text: 'Завтра в десять созвон' },
    })
    expect(r.json()).toEqual({ ok: true, waiting: true })
    const done = await app.inject({ url: `/api/talk/${body.talk}`, headers: { cookie: session } })
    expect(done.json()).toEqual({ state: 'done', text: 'Завтра в десять созвон', cards: 0 })
    const h = await app.inject({
      url: '/api/talk/history?agent=lora',
      headers: { cookie: session },
    })
    expect(h.json().lines.map((l: { author: string }) => l.author)).toEqual(['boris', 'lora'])
    const voice = await app.inject({
      method: 'POST',
      url: '/api/talk/speak',
      headers: { cookie: session },
      payload: { text: 'Завтра в десять', agent: 'lora' },
    })
    expect(voice.body).toBe('mp3:baya:Завтра в десять')
  })

  it('FR-NOTIF-5: Lora answers twice to one talk: «ща гляну» at once (more), then the answer itself', async () => {
    await lora_('/next', { key: 'lora-key' })
    const body = (await say('что там по Максу', 'lora')).json()
    await lora_('/next', { key: 'lora-key' })
    const first = await lora_('/reply', {
      method: 'POST',
      key: 'lora-key',
      payload: { talk: body.talk, text: 'Ща гляну, что там у Макса.', more: true },
    })
    expect(first.json()).toEqual({ ok: true, waiting: true })
    const ask = (after?: number) =>
      app.inject({
        url: `/api/talk/${body.talk}${after === undefined ? '' : `?after=${after}`}`,
        headers: { cookie: session },
      })
    expect((await ask()).json()).toEqual({
      state: 'done',
      text: 'Ща гляну, что там у Макса.',
      cards: 0,
      more: true,
    })
    // The second is not there yet: the app waits on.
    expect((await ask(1)).json()).toEqual({ state: 'waiting' })
    const second = await lora_('/reply', {
      method: 'POST',
      key: 'lora-key',
      payload: { talk: body.talk, text: 'Макс прислал макеты, ждёт ответа' },
    })
    expect(second.json()).toEqual({ ok: true, waiting: true })
    expect((await ask(1)).json()).toEqual({
      state: 'done',
      text: 'Макс прислал макеты, ждёт ответа',
      cards: 0,
    })
    // A phone that lost a reply asks again by the same number and gets the same answer.
    expect((await ask(0)).json()).toMatchObject({ text: 'Ща гляну, что там у Макса.', more: true })
    // After the last answer nothing more comes, and a late third reply is not waited for.
    expect((await ask(2)).statusCode).toBe(404)
    const late = await lora_('/reply', {
      method: 'POST',
      key: 'lora-key',
      payload: { talk: body.talk, text: 'И ещё' },
    })
    expect(late.json()).toEqual({ ok: true, waiting: false })
  })

  it('FR-NOTIF-5: Lora not on the line is said so at once', async () => {
    const r = await say('что у меня завтра', 'lora')
    expect(r.json()).toEqual({
      heard: 'что у меня завтра',
      talk: null,
      reply: { text: TALK_TEXTS.loraAway, buttons: false },
    })
  })

  it('FR-NOTIF-5: «позови Сару» brings Sara with her greeting, and a question after her name goes to her', async () => {
    const r = await say('Позови Сару', 'lora')
    expect(r.json()).toEqual({
      heard: 'Позови Сару',
      talk: null,
      switch: 'sara',
      reply: { text: AGENTS.sara.greeting, buttons: false },
    })
    expect(handled).toEqual([])
    const asked = await say('Позови Сару, что по лидам сегодня?', 'lora')
    expect(asked.json()).toMatchObject({
      heard: 'Позови Сару, что по лидам сегодня?',
      switch: 'sara',
    })
    expect(handled).toEqual([expect.objectContaining({ text: 'что по лидам сегодня?' })])
    const back = await say('верни Лору', 'sara')
    expect(back.json()).toMatchObject({ switch: 'lora', reply: { text: AGENTS.lora.greeting } })
  })
})

describe('the voice app: every request leaves a line', () => {
  it('FR-NOTIF-5: the log tells the path, the code and the time, never the words said', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => void lines.push(l))
    try {
      await app.inject({
        method: 'POST',
        url: '/api/talk?agent=sara',
        headers: { cookie: session },
        payload: { text: 'секретное слово' },
      })
      await app.inject({
        url: '/api/talk/0199a000-0000-7000-8000-000000000001',
        headers: { cookie: session },
      })
      await app.inject({
        method: 'POST',
        url: `/api/talk?agent=lora&diag=${encodeURIComponent('peak0.004,running,live,open,9.8s,audio/mp4')}`,
        headers: { cookie: session, 'content-type': 'audio/mp4' },
        payload: Buffer.from('fake m4a'),
      })
    } finally {
      spy.mockRestore()
    }
    const talk = lines.filter((l) => l.startsWith('talk '))
    expect(talk[2]).toContain('mic=peak0.004,running,live,open,9.8s,audio/mp4')
    expect(talk[0]).toMatch(/^talk POST \/api\/talk agent=sara 200 \d+ms body=\d+$/)
    expect(talk[1]).toMatch(/^talk GET \/api\/talk\/:id agent=- 404 /)
    expect(talk.join('\n')).not.toContain('секретное')
  })
})

describe('the voice app: a reply lost on a bad line', () => {
  it('FR-NOTIF-5: the phone names the talk, and asks by that name for an answer it never got', async () => {
    const id = '0199a000-0000-7000-8000-0000000000aa'
    // The phone sent the words but never got the reply: the answer waits under its own id.
    await app.inject({
      method: 'POST',
      url: `/api/talk?agent=lora&talk=${id}`,
      headers: { cookie: session },
      payload: { text: 'Позови Сару' },
    })
    const r = await app.inject({ url: `/api/talk/${id}`, headers: { cookie: session } })
    expect(r.json()).toEqual({
      state: 'done',
      text: AGENTS.sara.greeting,
      cards: 0,
      heard: 'Позови Сару',
      switch: 'sara',
    })
  })
})
