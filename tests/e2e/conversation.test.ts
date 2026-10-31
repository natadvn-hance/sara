import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { openReminders } from '../../apps/core/src/conversation/reminders'
import { moscowHour } from '../../apps/core/src/conversation/time'
import { conversation, convTurn, event, outbox } from '../../apps/core/src/db/schema'
import { setSetting } from '../../apps/core/src/settings/store'
import { interlocutorAnswer } from '../../apps/core/test/helpers/conversation'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

// Built on the fake chats of PR #110 (M4 part G): a chat of old Sara, the client writes, the card reaches Boris.

const ROOT = resolve(import.meta.dirname, '../..')
const BORIS = 111
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let n = 0
const chatId = () => `${Date.now()}${n++}`

async function until(cond: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('condition not met in time')
}
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms))
const cards = () => tg.sent.filter((m) => m.reply_markup && m.text.startsWith('💬'))
const button = (action: string) =>
  cards()
    .at(-1)
    ?.reply_markup?.inline_keyboard.flat()
    .find((b) => b.callback_data.endsWith(`:${action}`))?.callback_data ?? ''
const turns = () => db.select().from(convTurn)
const finished = async (k: number) => (await turns()).filter((t) => t.finishedAt).length >= k
async function count(type: string): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(event)
    .where(eq(event.type, type))
  return r[0]?.n ?? 0
}
const theConversation = async () => (await db.select().from(conversation))[0]

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
  // The Interlocutor and the Checker come with part D; a test copy of the roles has them.
  const dir = await mkdtemp(join(tmpdir(), 'e2e-conv-'))
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
    },
    {
      claudeEnv: () => ({
        FAKE_CLAUDE_MODE: 'ok',
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({ interlocutor: interlocutorAnswer() }),
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
  tg.sent.length = 0
  tg.edited.length = 0
  tg.answers.length = 0
  fake.messages.length = 0
  tg.pushStart(BORIS)
  await until(() => tg.sent.length === 1)
  tg.sent.length = 0
  await setSetting(db, 'pipeline.conversations', true, 'boris')
  await setSetting(db, 'conv.quiet_after_message_s', 1, 'boris')
  await setSetting(db, 'conv.quiet_after_typing_s', 1, 'boris')
  await setSetting(db, 'conv.max_wait_s', 20, 'boris')
  await setSetting(db, 'cards.quiet_hours', null, 'boris')
  // Never night here: the night is an hour that starts two hours from now.
  const h = moscowHour(new Date())
  await setSetting(db, 'conv.night', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'boris')
})

describe('a conversation end to end', () => {
  it('FR-CONV-7: three client messages with typing between them get one draft card (E9)', async () => {
    const chat = await oldChat()
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Здравствуйте' })
    await fake.emitTyping(chat)
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Как начнём?' })
    await fake.emitTyping(chat)
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'И по срокам' })
    await until(() => finished(1))
    await settle()
    const rows = await turns()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.messageIds).toHaveLength(3)
    expect(cards()).toHaveLength(1)
    // Each message reached Boris at once as its own; the one card does not repeat them.
    const said = tg.sent.filter((m) => !m.reply_markup && m.text.startsWith('💬 '))
    expect(said.map((m) => m.text.replace(/^💬 [^:]+: /, ''))).toEqual([
      'Здравствуйте',
      'Как начнём?',
      'И по срокам',
    ])
    expect(cards()[0]?.text).not.toContain('Здравствуйте')
    expect(cards()[0]?.text).toContain('Режим тени: клиенту ничего не ушло.')
  }, 40000)

  it('FR-CONV-5: in shadow nothing goes to the client and the real reply edits the card', async () => {
    const chat = await oldChat()
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Как начнём?' })
    await until(() => cards().length === 1)
    await until(() => finished(1))
    // Old Sara or Boris answers on the site: the card learns the real reply and its author.
    await fake.addChatMessage({
      chatId: chat,
      author: 'specialist',
      text: 'Начнём с короткого созвона, удобно завтра?',
    })
    await until(() => tg.edited.length === 1)
    expect(tg.edited[0]?.text).toContain('Сара v1 или ты')
    expect(fake.messages).toHaveLength(0)
    expect(await db.select().from(outbox)).toHaveLength(0)
    expect((await theConversation())?.owner).toBe('sara')
    expect(await count('conv.compared')).toBe(1)
  }, 40000)

  it('FR-CONV-10: after the switch Boris writing himself makes the client his and cancels the turn (E8)', async () => {
    await setSetting(db, 'conv.v1_writes', false, 'boris')
    await setSetting(db, 'conv.quiet_after_message_s', 4, 'boris')
    const chat = await oldChat()
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Сколько это стоит?' })
    await until(async () => (await turns()).length === 1)
    // Boris answers on the site while Sara waits for the client to finish.
    await fake.addChatMessage({
      chatId: chat,
      author: 'specialist',
      text: 'Анна, наберу вас через пять минут.',
    })
    await until(() => finished(1))
    const [t] = await turns()
    expect(t?.outcome).toBe('answered')
    expect(cards()).toHaveLength(0)
    expect(fake.messages).toHaveLength(0)
    expect(await theConversation()).toMatchObject({ owner: 'boris', ownerReason: 'wrote' })
    expect(await count('conv.boris_wrote')).toBe(1)
  }, 40000)

  it('FR-CONV-5: drafts mode end to end: after the switch nothing goes by itself, «Отправить» sends once', async () => {
    await setSetting(db, 'conv.v1_writes', false, 'boris')
    await setSetting(db, 'outbound.messages', true, 'boris')
    // Even a topic left at «сама» does not send while the autopilot is off.
    await setSetting(db, 'conv.autonomy', { process: 'self' } as never, 'boris')
    const chat = await oldChat()
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Как начнём?' })
    await until(() => cards().length === 1)
    await until(() => finished(1))
    await settle()
    expect(fake.messages).toHaveLength(0)
    expect(await db.select().from(outbox)).toHaveLength(0)
    const [t] = await turns()
    expect(t?.decision).toBe('draft')
    expect(cards()[0]?.text).toContain('<b>✍️ Ответ Сары:</b>')
    expect(cards()[0]?.text).not.toContain('Режим тени')
    const actions = cards()[0]
      ?.reply_markup?.inline_keyboard.flat()
      .map((b) => b.callback_data)
    expect(actions?.map((a) => a.split(':')[2])).toEqual(['send', 'edit', 'take', 'close'])
    tg.pushPress(BORIS, button('send'))
    await until(() => fake.messages.length === 1)
    // The press was answered at once, and the result came later as a message of its own.
    await until(() => tg.answers.some((a) => a.text === 'Отправляю…'))
    await until(() =>
      tg.sent.some((m) => m.text.startsWith('✅') && m.text.includes('Отправила клиенту')),
    )
    tg.pushPress(BORIS, button('send'))
    await settle()
    expect(fake.messages).toHaveLength(1)
    expect(fake.messages[0]?.idempotency_key).toMatch(/^msg:send:/)
    const queued = (await db.select().from(outbox)).filter((o) => o.kind === 'message')
    expect(queued).toHaveLength(1)
    expect(queued[0]?.state).toBe('confirmed')
  }, 50000)

  it('FR-CONV-12: a bid nobody answered gets a reminder process, and the client writing cancels it', async () => {
    const chat = await oldChat()
    await until(async () => (await theConversation()) !== undefined)
    const conv = await theConversation()
    await until(async () => (await openReminders(conv?.id ?? '')).length === 1)
    // In shadow the process only waits for its time: no card, no message, no outbox row.
    expect(tg.sent.filter((m) => m.reply_markup)).toHaveLength(0)
    expect(fake.messages).toHaveLength(0)
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Добрый день, посмотрю' })
    await until(async () => (await openReminders(conv?.id ?? '')).length === 0)
    await until(() => finished(1))
    expect(fake.messages).toHaveLength(0)
    expect(await db.select().from(outbox)).toHaveLength(0)
  }, 40000)

  it('FR-CONV-11: «Беру сам» by the button and «вернуть» in a reply to the card', async () => {
    const chat = await oldChat()
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'Как начнём?' })
    await until(() => cards().length === 1)
    await until(() => finished(1))
    tg.pushPress(BORIS, button('take'))
    await until(async () => (await theConversation())?.owner === 'boris')
    expect((await theConversation())?.ownerReason).toBe('take')
    const [t] = await turns()
    tg.pushText(BORIS, 'вернуть, клиент про цену, не торопись', t?.cardMessageId ?? undefined)
    await until(async () => (await theConversation())?.owner === 'sara')
    expect((await theConversation())?.borisNote).toMatch(
      /^\d\d\.\d\d: клиент про цену, не торопись$/,
    )
    // A client Boris took and gave back is Sara's again: the next client message gets a card.
    await fake.addChatMessage({ chatId: chat, author: 'client', text: 'А сроки какие?' })
    await until(() => cards().length === 2)
    expect(fake.messages).toHaveLength(0)
  }, 50000)
})
