import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ConverseResult } from '../../src/gateway/gateway'
import type { SecretaryWords } from '../../src/learning/inbox'
import { createTurnKeys } from '../../src/secretary/mcp'
import { createSecretary, SECRETARY_TEXTS } from '../../src/secretary/secretary'
import { memory } from '../../src/secretary/store'
import { runTool, type SecretaryDeps } from '../../src/secretary/tools'
import { setSetting } from '../../src/settings/store'
import type { TalkAnswer } from '../../src/talk/answers'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

let telegram: string[]
/** Whether each Telegram message went without a sound. */
let quiet: boolean[]
let typing: number
let answers: { talks: string[]; answer: TalkAnswer }[]
let reply: (configPath: string) => Promise<ConverseResult>
const keys = createTurnKeys()

const ok = (text: string): ConverseResult => ({ ok: true, text, durationMs: 5, modelCallId: 'm' })

async function secretary() {
  return createSecretary({
    db,
    converse: async (_role, _input, o) => reply(o.mcp?.configPath ?? ''),
    notifier: {
      sendText: async (text, o) => {
        telegram.push(text)
        quiet.push(o?.quiet ?? false)
        return { messageId: telegram.length }
      },
      typing: async () => {
        typing++
      },
    },
    keys,
    mcpUrl: () => 'http://127.0.0.1:9/internal/secretary/mcp',
    dataDir: await mkdtemp(join(tmpdir(), 'secretary-')),
    publicUrl: 'https://sara.example',
    titleOf: async () => null,
    answered: (talks, answer) => void answers.push({ talks, answer }),
  })
}

const words = (text: string, talk?: string): SecretaryWords => ({
  text,
  voice: talk !== undefined,
  at: new Date(),
  replyToText: null,
  questions: [],
  ...(talk && { talk }),
})

beforeEach(async () => {
  await resetDb(db)
  telegram = []
  quiet = []
  typing = 0
  answers = []
  reply = async () => ok('**Две** заявки в очереди')
})

describe('the voice app: the Secretary answers where Boris asked', () => {
  it('FR-NOTIF-5: words from the app get their answer in the app, and the chat in Telegram shows both quietly', async () => {
    const s = await secretary()
    await s.take(words('что в очереди', 'talk-1'))
    await s.idle()
    // One system with the chat (Boris, 09.11): his words and her answer are in Telegram too, without a sound,
    // since he is listening in the app.
    expect(telegram).toEqual([SECRETARY_TEXTS.fromApp(['что в очереди']), 'Две заявки в очереди'])
    expect(quiet).toEqual([true, true])
    expect(typing).toBe(0)
    expect(answers).toEqual([
      { talks: ['talk-1'], answer: { text: 'Две заявки в очереди', cards: 0 } },
    ])
    // The chat's memory is one: the next turn in Telegram reads what was said in the app.
    const lines = await memory(db, new Date(Date.now() + 1000), [])
    expect(lines.map((l) => [l.author, l.text])).toEqual([
      ['boris', 'что в очереди'],
      ['sara', '**Две** заявки в очереди'],
    ])
  })

  it('FR-NOTIF-5: words from Telegram are answered in Telegram as before', async () => {
    const s = await secretary()
    await s.take(words('что в очереди'))
    await s.idle()
    expect(telegram).toEqual(['Две заявки в очереди'])
    expect(typing).toBeGreaterThan(0)
    expect(answers).toEqual([])
  })

  it('FR-NOTIF-5: a turn with words from both places answers in both, and a Telegram that fails still answers the app', async () => {
    let release: () => void = () => {}
    const busy = new Promise<void>((r) => {
      release = r
    })
    let first = true
    reply = async () => {
      // The first turn holds, so the next words from both places wait and go together in one turn.
      if (first) {
        first = false
        await busy
      }
      return ok('Отвечаю обоим')
    }
    const s = await secretary()
    await s.take(words('первое', 'talk-a'))
    await s.take(words('из телеграма'))
    await s.take(words('из приложения', 'talk-b'))
    release()
    await s.idle()
    expect(answers).toEqual([
      { talks: ['talk-a'], answer: { text: 'Отвечаю обоим', cards: 0 } },
      { talks: ['talk-b'], answer: { text: 'Отвечаю обоим', cards: 0 } },
    ])
    // The app's words show above each answer; the turn with his Telegram words rings as before.
    expect(telegram).toEqual([
      SECRETARY_TEXTS.fromApp(['первое']),
      'Отвечаю обоим',
      SECRETARY_TEXTS.fromApp(['из приложения']),
      'Отвечаю обоим',
    ])
    expect(quiet).toEqual([true, true, true, false])

    answers = []
    const broken = await createSecretary({
      db,
      converse: async () => ok('Ответ'),
      notifier: {
        sendText: async () => {
          throw new Error('telegram down')
        },
      },
      keys,
      mcpUrl: () => 'http://127.0.0.1:9/internal/secretary/mcp',
      dataDir: await mkdtemp(join(tmpdir(), 'secretary-')),
      publicUrl: 'https://sara.example',
      titleOf: async () => null,
      answered: (talks, answer) => void answers.push({ talks, answer }),
    })
    await broken.take(words('из телеграма'))
    await broken.take(words('из приложения', 'talk-c'))
    await broken.idle()
    expect(answers[0]).toEqual({ talks: ['talk-c'], answer: { text: 'Ответ', cards: 0 } })
    // Words from the app alone: a Telegram that fails changes nothing for the app.
    answers = []
    await broken.take(words('ещё раз', 'talk-d'))
    await broken.idle()
    expect(answers).toEqual([{ talks: ['talk-d'], answer: { text: 'Ответ', cards: 0 } }])
  })

  it('FR-NOTIF-5: the cap and a failure reach the app too', async () => {
    await setSetting(db, 'secretary.turns_per_day', 0, 'system')
    const s = await secretary()
    await s.take(words('что в очереди', 'talk-2'))
    await s.idle()
    expect(answers).toEqual([
      { talks: ['talk-2'], answer: { text: SECRETARY_TEXTS.cap(0), cards: 0 } },
    ])
    await setSetting(db, 'secretary.turns_per_day', 60, 'system')
    reply = async () => {
      throw new Error('boom')
    }
    await s.take(words('а сейчас', 'talk-3'))
    await s.idle()
    expect(answers.at(-1)).toEqual({
      talks: ['talk-3'],
      answer: { text: SECRETARY_TEXTS.failed, cards: 0 },
    })
    expect(telegram).toEqual([
      SECRETARY_TEXTS.fromApp(['что в очереди']),
      SECRETARY_TEXTS.cap(0),
      SECRETARY_TEXTS.fromApp(['а сейчас']),
      SECRETARY_TEXTS.failed,
    ])
  })

  it('FR-NOTIF-5: the app hears how many cards with buttons the turn sent to Telegram', async () => {
    const q = {
      id: '0199a000-0000-7000-8000-000000000009',
      kind: 'edit_price',
      entityId: '95147898',
      telegramMessageId: 5,
      askedAt: new Date().toISOString(),
      answeredAt: null,
      answer: null,
    }
    const cards: string[] = []
    const deps = {
      notifier: {
        sendButtons: async (text: string) => {
          cards.push(text)
          return { messageId: 1 }
        },
      },
      // The answer to the question comes with buttons: the tool relays them to Telegram.
      answerQuestion: async () => ({
        text: 'Цена 15 000 ₽, отправить?',
        rows: [[{ text: 'Откликнуться', callbackData: 'x' }]],
      }),
    } as unknown as SecretaryDeps
    reply = async (configPath) => {
      // The CLI calls a tool with the turn's key: the fake finds the turn by it, as the MCP server does.
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      const t = keys.find(config.mcpServers.sara.headers.Authorization.slice('Bearer '.length))
      if (!t) throw new Error('no turn')
      await runTool(deps, t, 'answer_question', { questionId: q.id })
      return ok('Записала цену, кнопка в Telegram')
    }
    const s = await secretary()
    await s.take({ ...words('пятнадцать тысяч', 'talk-4'), questions: [q] })
    await s.idle()
    expect(cards).toEqual(['Цена 15 000 ₽, отправить?'])
    expect(answers.at(-1)).toEqual({
      talks: ['talk-4'],
      answer: { text: 'Записала цену, кнопка в Telegram', cards: 1 },
    })
  })
})
