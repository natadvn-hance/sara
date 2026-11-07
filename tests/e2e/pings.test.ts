import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { moscowHour } from '../../apps/core/src/conversation/time'
import { convTurn } from '../../apps/core/src/db/schema'
import { forumOf } from '../../apps/core/src/notify/forum'
import { setSetting } from '../../apps/core/src/settings/store'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

// Spec 2026-11-07-organic-pings: a client silent since the bid gets a ping the Pinger wrote, as a card in his own
// topic of Boris's forum, with why now and the page of its fact; nothing goes to him until Boris presses «Отправить».
// The fake Claude answers the Pinger as a stream with the pages its web search «gave».

const ROOT = resolve(import.meta.dirname, '../..')
const BORIS = 111
const FORUM = -1009876543210
const PAGE = 'https://example.ru/clinics/online-2026'
const FACT = 'Онлайн записей в частные клиники стало на 12% больше'
const PING = {
  decision: 'ping',
  why_now: 'Отклик не прочитан, есть свежий повод про онлайн запись',
  text: 'Добрый день! Заметил, что онлайн записей в частные клиники стало на 12% больше. Как у вас с сайтом?',
  hook: { fact: FACT, source_url: PAGE },
  fact_ids: [],
  $web: [PAGE],
}
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let pinger: unknown = PING
let n = 0
const chatId = () => `${Date.now()}${n++}`

async function until(cond: () => boolean | Promise<boolean>, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('condition not met in time')
}
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms))
const inForum = () => tg.sent.filter((m) => m.chat_id === FORUM)
const pingCards = () => inForum().filter((m) => m.text.startsWith('⏰ Напомнить клиенту?'))
const clientTopic = () => tg.topics.find((t) => t.name !== 'Заявки')

/** Old Sara's bid 26 hours ago that the client never opened: the first ping is due now. */
async function silentBid(): Promise<string> {
  const id = chatId()
  await fake.addChatMessage({
    chatId: id,
    orderId: id,
    author: 'specialist',
    text: 'Анна, добрый день! Понимаю задачу, сделаем сайт для клиники за три недели.',
    read: false,
    sentAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
  })
  return id
}

beforeAll(async () => {
  tg = await createFakeTelegram()
  fake = await createFakeProfi({
    port: 0,
    coreEventsUrl: 'http://127.0.0.1:1',
    nodeToken: 'node-tok',
    permitSecret: 'permit',
  })
  const dir = await mkdtemp(join(tmpdir(), 'e2e-pings-'))
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
  app = await startApp(
    {
      ...loadConfig({}),
      databaseUrl: testDatabaseUrl(),
      dataDir: join(dir, 'data'),
      rolesDir: join(dir, 'roles'),
      mindDir: join(dir, 'no-mind'),
      port: 0,
      profiMcpUrl: fake.url,
      nodeToken: 'node-tok',
      permitSecret: 'permit',
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      telegramApiRoot: tg.apiRoot,
    },
    {
      claudeEnv: () => ({
        FAKE_CLAUDE_MODE: 'ok',
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({ pinger }),
      }),
      learningTickMs: 3_600_000,
      remindAfterMs: async () => 3_600_000,
    },
  )
  fake.setCoreEventsUrl(`${app.url}/internal/profi/events`)
  await app.secrets.set('claude_oauth_token', 'tok')
  await app.secrets.set('telegram_bot_token', tg.token)
  await app.bot.start(tg.token)
}, 60000)

afterAll(async () => {
  await app.close()
  await fake.close()
  await tg.close()
  await close()
})

beforeEach(async () => {
  await resetDb(db)
  pinger = PING
  tg.sent.length = 0
  tg.topics.length = 0
  fake.messages.length = 0
  tg.pushStart(BORIS)
  await until(() => tg.sent.length === 1)
  tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: '/forum' })
  await until(async () => (await forumOf(db)) !== null)
  await setSetting(db, 'pipeline.conversations', true, 'boris')
  await setSetting(db, 'cards.quiet_hours', null, 'boris')
  const h = moscowHour(new Date())
  await setSetting(db, 'conv.night', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'boris')
  await setSetting(db, 'conv.reminder_quiet', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'boris')
  // Drafts mode after the switch: nothing goes to a client without Boris's press.
  await setSetting(db, 'conv.v1_writes', false, 'boris')
  await setSetting(db, 'outbound.messages', true, 'boris')
}, 30000)

describe('an organic ping in the client’s topic', () => {
  it('FR-CONV-12: the card says why now and where the fact is from; «Отправить» sends it once', async () => {
    await silentBid()
    await until(() => pingCards().length === 1, 40000)
    const card = pingCards()[0]
    const topic = clientTopic()
    expect(card?.message_thread_id).toBe(topic?.message_thread_id)
    expect(card?.text).toContain(
      'Почему сейчас: Отклик не прочитан, есть свежий повод про онлайн запись',
    )
    expect(card?.text).toContain(PING.text)
    expect(card?.text).toContain(`Источник факта: ${PAGE}`)
    expect(card?.text).not.toMatch(/[\u2013\u2014]/)
    expect(fake.messages).toHaveLength(0)
    const send =
      card?.reply_markup?.inline_keyboard.flat().find((b) => b.callback_data.endsWith(':send'))
        ?.callback_data ?? ''
    tg.pushGroupPress(FORUM, BORIS, send, topic?.message_thread_id)
    await until(() => fake.messages.length === 1)
    expect(fake.messages[0]?.text).toBe(PING.text)
    tg.pushGroupPress(FORUM, BORIS, send, topic?.message_thread_id)
    await settle()
    expect(fake.messages).toHaveLength(1)
  }, 60000)

  it('FR-CONV-12: a fact with no page the search gave never reaches the card; a plain check-in goes instead', async () => {
    pinger = { ...PING, $web: ['https://other.ru/unrelated'] }
    await silentBid()
    await until(() => pingCards().length === 1, 40000)
    const card = pingCards()[0]?.text ?? ''
    expect(card).not.toContain('12%')
    expect(card).not.toContain('Источник факта')
    expect(card).toContain(
      'Почему сейчас: Клиент молчит с отклика. Наше сообщение еще не прочитано',
    )
    const [row] = await db.select().from(convTurn)
    expect((row?.checks as { fallback?: boolean } | null)?.fallback).toBe(true)
    expect(fake.messages).toHaveLength(0)
  }, 60000)
})
