import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { newEventId } from '@sara/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { moscowDayStart } from '../../apps/core/src/conversation/cards'
import { ensureConversation } from '../../apps/core/src/conversation/store'
import {
  chatMessage,
  convTurn,
  jobRun,
  lead,
  mindIndex,
  mindProposal,
} from '../../apps/core/src/db/schema'
import { setSetting } from '../../apps/core/src/settings/store'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

// ST-M7-19 (docs/product/boris-replies-digest.md): the post from the core's own timer, through the real gateway on the
// fake CLI and the real bot on the fake Telegram, to the proposal a press makes. All the data here is made up.

const ROOT = resolve(import.meta.dirname, '../..')
const BORIS = 111
const { db, close } = openTestDb()

let tg: FakeTelegram
let app: RunningApp
/** 11:00 Moscow today: the morning post is due whatever the clock of the run. */
const NOW = new Date(new Date(moscowDayStart(new Date())).getTime() + 11 * 3600_000)
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3600_000).toISOString()

async function until(cond: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}

const post = () => tg.sent.find((m) => m.text.startsWith('📚'))
const REPLY = 'Сделаем макет бесплатно, начнем на этой неделе'

async function chatWithReply() {
  await db.insert(lead).values({
    id: '95000001',
    accountId: 'hance-marketing',
    title: 'Сайт',
    category: 'Сайты',
    city: 'Краснодар',
    text: 'Нужен сайт',
    clientName: 'Ирина',
    bidPriceRub: 100,
    seenAt: ago(30),
    correlationId: newEventId(),
  })
  const conv = await ensureConversation(db, {
    accountId: 'hance-marketing',
    chatId: '95000001',
    orderId: '95000001',
  })
  const message = (
    id: string,
    side: string,
    author: string,
    basis: string,
    text: string,
    at: string,
  ) =>
    db.insert(chatMessage).values({
      id: newEventId(),
      accountId: 'hance-marketing',
      chatId: '95000001',
      orderId: '95000001',
      platformMessageId: id,
      side,
      author,
      authorBasis: basis,
      text,
      sentAt: at,
      source: 'node',
      conversationId: conv.id,
    })
  await message('c-1', 'client', 'client', 'side', 'Ирина меня зовут, а макет покажете?', ago(26))
  await db.insert(convTurn).values({
    id: 't-1',
    conversationId: conv.id,
    kind: 'reply',
    anchorMessageId: 'c-1',
    messageIds: ['c-1'],
    state: 'finished',
    text: 'Покажу примеры работ на созвоне, удобно завтра?',
    outcome: 'drafted',
    understanding: { topic: 'cases', tone: 'neutral' },
    createdAt: ago(25.5),
  })
  await message('b-1', 'specialist', 'boris', 'after_cutover', REPLY, ago(24))
}

beforeAll(async () => {
  tg = await createFakeTelegram()
  const dir = await mkdtemp(join(tmpdir(), 'e2e-digest-'))
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
  app = await startApp(
    {
      ...loadConfig({}),
      databaseUrl: testDatabaseUrl(),
      dataDir: join(dir, 'data'),
      rolesDir: join(dir, 'roles'),
      mindDir: join(dir, 'no-mind'),
      port: 0,
      nodeToken: 'node-tok',
      permitSecret: 'permit',
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      telegramApiRoot: tg.apiRoot,
    },
    {
      claudeEnv: () => ({
        FAKE_CLAUDE_MODE: 'ok',
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
          'reply-cleaner': { replies: [{ n: 1, text: REPLY }] },
        }),
      }),
      learningTickMs: 200,
      now: () => NOW,
    },
  )
  await app.secrets.set('claude_oauth_token', 'tok')
  await app.secrets.set('telegram_bot_token', tg.token)
  await app.bot.start(tg.token)
}, 60000)

afterAll(async () => {
  await app.close()
  await tg.close()
  await close()
})

beforeEach(async () => {
  await resetDb(db)
  tg.sent.length = 0
  tg.edited.length = 0
  tg.answers.length = 0
  tg.pushStart(BORIS)
  await until(() => tg.sent.length === 1)
})

describe('the daily post of Boris replies, end to end', () => {
  it('FR-SPEECH-5: off by default, the timer posts nothing', async () => {
    await chatWithReply()
    await new Promise((r) => setTimeout(r, 800))
    expect(post()).toBeUndefined()
    expect(await db.select().from(jobRun)).toHaveLength(0)
  })

  it('FR-SPEECH-5: turned on, the timer posts once without a sound, and a press makes a proposal and edits the post', async () => {
    await chatWithReply()
    await setSetting(db, 'digest.boris_replies', true, 'system')
    await until(() => post() !== undefined)
    const message = post()
    expect(message?.disable_notification).toBe(true)
    expect(message?.text).toContain('[имя 1]')
    expect(message?.text).not.toContain('Ирина')
    expect(message?.text).toContain('Обещание: бесплатно')

    const buttons = message?.reply_markup?.inline_keyboard.flat() ?? []
    expect(buttons.map((b) => b.text)).toEqual(['1: В образцы', '1: Не надо'])
    tg.pushPress(BORIS, buttons[0]?.callback_data ?? '')
    await until(() => tg.answers.length === 1)
    expect(tg.answers[0]?.text).toContain('предложением')

    const rows = await db.select().from(mindProposal)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe('new')
    expect(rows[0]?.content).toContain('status: proposal')
    expect(rows[0]?.content).toContain('## Исход')
    // Nothing went into the confirmed mind.
    expect(await db.select().from(mindIndex)).toHaveLength(0)

    await until(() => tg.edited.length === 1)
    expect(tg.edited[0]?.text).toContain('✅')
    expect(tg.edited[0]?.reply_markup?.inline_keyboard ?? []).toEqual([])

    // The next ticks of the same day change nothing.
    await new Promise((r) => setTimeout(r, 600))
    expect(tg.sent.filter((m) => m.text.startsWith('📚'))).toHaveLength(1)
  }, 30000)
})
