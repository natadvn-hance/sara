import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createStand, type Stand } from '@sara/profi-node/stand'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { moscowHour } from '../../apps/core/src/conversation/time'
import { setSetting } from '../../apps/core/src/settings/store'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { interlocutorAnswer } from '../../apps/core/test/helpers/conversation'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

// The test stand (docs/ops/staging.md): the core of any branch, unchanged, against the stand's Profi.ru. Boris's
// whole path without money: order, bid, series, the client's answer, the draft, «Отправить». Invented texts only.
const ROOT = resolve(import.meta.dirname, '../..')
const BORIS = 111
const FIT = '{"verdict":"fit","reason":"Нужна стратегия","tags":["стратегия"],"confidence":0.9}'
const BODY = 'Прочитал заказ, сети студий важно понять, кто их клиент.\n\nС чего хотите начать?'
const FIRST = 'Из недавнего, похожая задача)'
const SECOND = 'Сделаем быстро и без лишних трат)'
const QUESTION = 'Здравствуйте! А как вы обычно начинаете?'
const REPLY = interlocutorAnswer().text
const NOON = new Date('2026-10-26T09:00:00Z')
const { db, close } = openTestDb()

let tg: FakeTelegram
let stand: Stand
let app: RunningApp

async function until(cond: () => boolean | Promise<boolean>, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('condition not met in time')
}
const buttonOf = (start: string, action: string) =>
  tg.sent
    .filter((m) => m.reply_markup && m.text.startsWith(start))
    .at(-1)
    ?.reply_markup?.inline_keyboard.flat()
    .find((b) => b.callback_data.endsWith(`:${action}`))?.callback_data ?? ''
const chat = (id: string) =>
  stand.fake
    .snapshot()
    .chats.find((c) => c.chatId === id)
    ?.messages.map((m) => `${m.author}: ${m.text}`) ?? []

beforeAll(async () => {
  tg = await createFakeTelegram()
  const dir = await mkdtemp(join(tmpdir(), 'e2e-stand-'))
  stand = await createStand({
    port: 0,
    coreEventsUrl: 'http://127.0.0.1:1',
    nodeToken: 'node-tok',
    permitSecret: 'permit',
    dataDir: join(dir, 'stand'),
    model: async () => ({ error: 'модель в этом тесте не нужна' }),
    timing: { readMs: [50, 100], firstReplyMs: [1500, 1500], replyMs: [800, 800], typingMs: 50 },
    limits: { daily: 40, perChat: 8 },
  })
  // The Interlocutor and the Checker answer by the test copy of the roles, as in the conversation e2e.
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
  for (const [name, model] of [
    ['interlocutor', 'sonnet'],
    ['checker', 'haiku'],
  ] as const) {
    await mkdir(join(dir, 'roles', name), { recursive: true })
    await writeFile(
      join(dir, 'roles', name, 'meta.json'),
      JSON.stringify({ name, version: 1, model, priority: 'P0', timeoutMs: 30000 }),
    )
    await writeFile(join(dir, 'roles', name, 'role.md'), 'Роль для теста.')
  }
  app = await startApp(
    {
      ...loadConfig({}),
      databaseUrl: testDatabaseUrl(),
      dataDir: join(dir, 'data'),
      rolesDir: join(dir, 'roles'),
      mindDir: join(dir, 'no-mind'),
      port: 0,
      profiMcpUrl: `${stand.url}/mcp`,
      nodeToken: 'node-tok',
      permitSecret: 'permit',
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      telegramApiRoot: tg.apiRoot,
    },
    {
      claudeEnv: () => ({
        FAKE_CLAUDE_MODE: 'ok',
        FAKE_CLAUDE_OUTPUT: FIT,
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
          analyst: {
            ...analystAnswer(BODY, 60000),
            follow_ups: [
              { text: FIRST, case_id: null },
              { text: SECOND, case_id: null },
            ],
          },
          interlocutor: interlocutorAnswer(),
        }),
      }),
      retryDelaysMs: [50, 50],
      busyRetry: { delayMs: 50, tries: 2 },
      reconcileDelaysMs: [200, 200],
      learningTickMs: 3_600_000,
      remindAfterMs: async () => 3_600_000,
      notifyRetry: { maxAttempts: 4, intervalSeconds: 0.5 },
      seriesDelayMs: { first: [300, 400], next: [200, 300] },
      now: () => NOON,
    },
  )
  stand.fake.setCoreEventsUrl(`${app.url}/internal/profi/events`)
  await app.secrets.set('claude_oauth_token', 'tok')
  await app.secrets.set('telegram_bot_token', tg.token)
  await app.bot.start(tg.token)
  await resetDb(db)
  tg.pushStart(BORIS)
  await until(() => tg.sent.length === 1)
  // The stand's settings (scripts/staging/server.sh): bids and messages go, made up and free; drafts mode as live.
  for (const [key, value] of [
    ['outbound.bids', true],
    ['outbound.messages', true],
    ['pipeline.leads', true],
    ['pipeline.conversations', true],
    ['conv.v1_writes', false],
    ['conv.autopilot', false],
    ['cards.quiet_hours', null],
    ['conv.quiet_after_message_s', 1],
    ['conv.quiet_after_typing_s', 1],
    ['conv.max_wait_s', 20],
  ] as const)
    await setSetting(db, key, value as never, 'boris')
  // Never night here: the night is an hour that starts two hours from now.
  const h = moscowHour(new Date())
  await setSetting(db, 'conv.night', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'boris')
}, 60000)

afterAll(async () => {
  await app.close()
  await stand.close()
  await tg.close()
  await close()
})

describe('the test stand end to end', () => {
  it('NFR-MAINT-1: order, bid, series, the client answers, the draft goes by «Отправить», and no ruble is real', async () => {
    const id = await stand.addOrder({
      from: 'sample:90000015',
      behaviour: 'script',
      script: [{ wait_s: 1, text: QUESTION }],
    })
    await until(() => buttonOf('', 'bid') !== '')
    tg.pushPress(BORIS, buttonOf('', 'bid'))
    await until(() => stand.fake.bids.length === 1)
    // The bid, its two messages, then the client, who waited until the series was over.
    await until(() => chat(id).length === 4)
    expect(chat(id).slice(1)).toEqual([
      `specialist: ${FIRST}`,
      `specialist: ${SECOND}`,
      `client: ${QUESTION}`,
    ])
    expect(chat(id)[0]).toMatch(/^specialist: .*добрый день!/)
    expect(chat(id)[0]).toContain('сети студий важно понять, кто их клиент')
    await until(() => buttonOf('💬', 'send') !== '')
    expect(tg.sent.filter((m) => m.text.startsWith('💬')).at(-1)?.text).toContain(QUESTION)
    tg.pushPress(BORIS, buttonOf('💬', 'send'))
    await until(() => chat(id).length === 5)
    expect(chat(id)[4]).toBe(`specialist: ${REPLY}`)
    // The made-up wallet paid for the bid; nothing else was spent anywhere.
    expect(stand.fake.snapshot().balance).toBe(5000 - 210)
    expect(stand.state.plans[id]).toMatchObject({ replies: 1, ended: true })
  }, 60000)
})
