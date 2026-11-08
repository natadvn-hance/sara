import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { moscowHour } from '../../apps/core/src/conversation/time'
import { conversation, convTurn, event } from '../../apps/core/src/db/schema'
import { forumOf } from '../../apps/core/src/notify/forum'
import { setSetting } from '../../apps/core/src/settings/store'
import { interlocutorAnswer } from '../../apps/core/test/helpers/conversation'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

// ST-M7-16 (docs/product/telegram-forum.md): the whole path in Boris's forum, a client's chat on the fake Profi.ru
// and the fake Telegram. Without a forum the same path is tests/e2e/conversation.test.ts, unchanged.

const ROOT = resolve(import.meta.dirname, '../..')
const BORIS = 111
const FORUM = -1009876543210
const { db, close } = openTestDb()

let tg: FakeTelegram
let closeStt: () => void = () => {}
let fake: FakeProfi
let app: RunningApp
let n = 0
const chatId = () => `${Date.now()}${n++}`
/** What each role answers; the topic chat's answer is a script of tool calls and words (tests/fakes/fake-claude.mjs). */
let byRole: Record<string, unknown> = {}
/** Lora's speech service as the core sees it: a unix socket answering one JSON line. */
let heard = 'предложи созвон в четверг'
let voiceDir = ''

async function until(cond: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('condition not met in time')
}
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms))
const inForum = () => tg.sent.filter((m) => m.chat_id === FORUM)
const cards = () => inForum().filter((m) => m.reply_markup && m.text.startsWith('💬'))
const button = (action: string) =>
  cards()
    .at(-1)
    ?.reply_markup?.inline_keyboard.flat()
    .find((b) => b.callback_data.endsWith(`:${action}`))?.callback_data ?? ''
const finished = async (k: number) =>
  (await db.select().from(convTurn)).filter((t) => t.finishedAt).length >= k
const clientTopic = () => tg.topics.find((t) => t.name !== 'Заявки')

/** A chat old Sara began an hour ago with her bid, as the fake service shows it. */
async function oldChat(): Promise<string> {
  const id = chatId()
  await fake.addChatMessage({
    chatId: id,
    orderId: id,
    author: 'specialist',
    text: 'Анна, добрый день! Понимаю задачу, сделаем сайт за три недели.',
    read: true,
    sentAt: new Date(Date.now() - 3600_000).toISOString(),
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
  const dir = await mkdtemp(join(tmpdir(), 'e2e-forum-'))
  voiceDir = await mkdtemp(join(tmpdir(), 'e2e-voice-'))
  const stt = createServer((c) => {
    let buf = ''
    c.on('data', (b) => {
      buf += b.toString()
      if (buf.includes('\n')) c.end(`${JSON.stringify({ ok: true, text: heard })}\n`)
    })
  })
  await new Promise<void>((ok) => stt.listen(join(voiceDir, 'stt.sock'), ok))
  closeStt = () => stt.close()
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
      profiMcpUrl: fake.url,
      nodeToken: 'node-tok',
      permitSecret: 'permit',
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      telegramApiRoot: tg.apiRoot,
      voiceSocket: join(voiceDir, 'stt.sock'),
      voiceDropDir: join(voiceDir, 'in'),
    },
    {
      claudeEnv: () => ({
        FAKE_CLAUDE_MODE: 'ok',
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify(byRole),
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
  closeStt()
  await app.close()
  await fake.close()
  await tg.close()
  await close()
})

beforeEach(async () => {
  byRole = { interlocutor: interlocutorAnswer() }
  await resetDb(db)
  tg.sent.length = 0
  tg.topics.length = 0
  fake.messages.length = 0
  tg.pushStart(BORIS)
  await until(() => tg.sent.length === 1)
  tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: '/forum' })
  await until(async () => (await forumOf(db)) !== null)
  await setSetting(db, 'pipeline.conversations', true, 'boris')
  await setSetting(db, 'conv.quiet_after_message_s', 1, 'boris')
  await setSetting(db, 'conv.quiet_after_typing_s', 1, 'boris')
  await setSetting(db, 'conv.max_wait_s', 20, 'boris')
  await setSetting(db, 'cards.quiet_hours', null, 'boris')
  const h = moscowHour(new Date())
  await setSetting(db, 'conv.night', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'boris')
  // Drafts mode after the switch: nothing goes to a client without Boris's press.
  await setSetting(db, 'conv.v1_writes', false, 'boris')
  await setSetting(db, 'outbound.messages', true, 'boris')
}, 30000)

describe('a client in his own topic of the forum', () => {
  it('ST-M7-16: the client’s words come as a card in his topic, and «Отправить» there sends once', async () => {
    const chat = await oldChat()
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Как начнём?' })
    await until(() => cards().length === 1)
    await until(() => finished(1))
    const topic = clientTopic()
    expect(topic?.name).toContain(`№${chat}`)
    expect(cards()[0]?.message_thread_id).toBe(topic?.message_thread_id)
    // Nothing of the client reached Boris's own chat.
    expect(tg.sent.filter((m) => m.chat_id === BORIS && m.text.startsWith('💬'))).toEqual([])
    expect(fake.messages).toHaveLength(0)
    tg.pushGroupPress(FORUM, BORIS, button('send'), topic?.message_thread_id)
    await until(() => fake.messages.length === 1)
    // The result comes to the same topic.
    await until(() =>
      inForum().some(
        (m) =>
          m.text.includes('Отправила клиенту') && m.message_thread_id === topic?.message_thread_id,
      ),
    )
    tg.pushGroupPress(FORUM, BORIS, button('send'), topic?.message_thread_id)
    await settle()
    expect(fake.messages).toHaveLength(1)
  }, 50000)

  it('ST-M7-16: Boris’s words in the topic go to the client only after his «Отправить», exactly as written', async () => {
    const chat = await oldChat()
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Как начнём?' })
    await until(() => cards().length === 1)
    await until(() => finished(1))
    const thread = clientTopic()?.message_thread_id
    const words = 'Анна, давайте завтра в 11 созвонимся, наберу сам.'
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: `напиши: ${words}`, thread })
    await until(() => inForum().some((m) => m.text === `Отправлю клиенту так: «${words}»`))
    const confirm = inForum().find((m) => m.text === `Отправлю клиенту так: «${words}»`)
    expect(confirm?.message_thread_id).toBe(thread)
    await settle()
    expect(fake.messages).toHaveLength(0)
    const send =
      confirm?.reply_markup?.inline_keyboard.flat().find((b) => b.callback_data.endsWith(':send'))
        ?.callback_data ?? ''
    tg.pushGroupPress(FORUM, BORIS, send, thread)
    await until(() => fake.messages.length === 1)
    expect(fake.messages[0]?.text).toBe(words)
  }, 50000)

  it('ST-M7-16: «закрой» in the topic closes the conversation and the topic; the client writing opens it again', async () => {
    const chat = await oldChat()
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Как начнём?' })
    await until(() => cards().length === 1)
    await until(() => finished(1))
    const topic = clientTopic()
    tg.pushGroupText({
      chatId: FORUM,
      fromId: BORIS,
      text: 'закрой',
      thread: topic?.message_thread_id,
    })
    await until(() => topic?.closed === true)
    expect(topic?.name).toMatch(/ · закрыт$/)
    expect((await db.select().from(conversation))[0]?.closedAt).not.toBeNull()
    // A closed conversation: the client's next words come to Boris, and the topic opens.
    await fake.addChatMessage({
      chatId: chat,
      author: 'client',
      text: 'А всё-таки, сколько стоит?',
    })
    await until(() => topic?.closed === false, 30000)
    expect(topic?.name).not.toMatch(/закрыт/)
    expect(fake.messages).toHaveLength(0)
  }, 60000)

  it('ST-M7-16: words in the topic go to Sara, her version comes with «Отправить», and after the send the discussion leaves the topic', async () => {
    const chat = await oldChat()
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Сколько стоит сайт?' })
    await until(() => cards().length === 1)
    await until(() => finished(1))
    const thread = clientTopic()?.message_thread_id
    const version = 'Добрый день! Давайте обсудим объем на созвоне в четверг.'
    byRole['topic-chat'] = {
      calls: [{ name: 'propose', arguments: { text: version } }],
      answer: 'Готово',
    }
    tg.pushGroupText({
      chatId: FORUM,
      fromId: BORIS,
      text: 'без цены, позови на созвон в четверг',
      thread,
    })
    const card = `Отправлю клиенту так: «${version}»`
    await until(() => inForum().some((m) => m.text === card))
    const confirm = inForum().find((m) => m.text === card)
    expect(confirm?.message_thread_id).toBe(thread)
    await settle()
    expect(fake.messages).toHaveLength(0)
    // «Готово» after a version is not posted: the card says it.
    expect(inForum().some((m) => m.text === 'Готово')).toBe(false)
    const send =
      confirm?.reply_markup?.inline_keyboard.flat().find((b) => b.callback_data.endsWith(':send'))
        ?.callback_data ?? ''
    tg.pushGroupPress(FORUM, BORIS, send, thread)
    await until(() => fake.messages.length === 1)
    expect(fake.messages[0]?.text).toBe(version)
    // Once the topic shows the sent message, his words and the version card are deleted; the client's post stays.
    await until(() => tg.deleted.length === 2, 30000)
    expect(tg.deleted.map((d) => d.message_id)).toContain(confirm?.message_id)
    const clientPost = inForum().find((m) => m.text.includes('Сколько стоит сайт?'))
    expect(tg.deleted.map((d) => d.message_id)).not.toContain(clientPost?.message_id)
    // The journal line is written once every post is dealt with.
    await until(
      async () =>
        (await db.select().from(event).where(eq(event.type, 'topic.discussion_cleared'))).length ===
        1,
    )
  }, 60000)

  it('ST-M7-16: a voice in the topic is heard by the speech service, its transcript comes folded, and Sara answers there', async () => {
    const chat = await oldChat()
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Когда сможете начать?' })
    await until(() => cards().length === 1)
    await until(() => finished(1))
    const thread = clientTopic()?.message_thread_id
    heard = 'спроси, удобен ли ей четверг'
    byRole['topic-chat'] = { calls: [], answer: 'Какой четверг предложить, этот или следующий?' }
    tg.pushGroupVoice({ chatId: FORUM, fromId: BORIS, thread })
    await until(() => inForum().some((m) => m.text.startsWith('Какой четверг')))
    const transcript = inForum().find((m) => m.text.includes('спроси, удобен ли ей четверг'))
    expect(transcript?.message_thread_id).toBe(thread)
    expect(transcript?.parse_mode).toBe('HTML')
    expect(transcript?.text).toContain('<blockquote expandable>')
    expect(fake.messages).toHaveLength(0)
  }, 60000)
})
