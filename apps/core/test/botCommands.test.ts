import { formatRub, newEventId } from '@sara/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../tests/fakes/telegramApi'
import { lead, task } from '../src/db/schema'
import { COMMAND_TEXTS, COMMANDS, helpText } from '../src/notify/botCommands'
import { forumOf } from '../src/notify/forum'
import { createTelegramRuntime, type TelegramRuntime } from '../src/notify/telegram'
import { getSetting, setSetting } from '../src/settings/store'
import { openTestDb, resetDb } from './helpers/db'
import { countEvents } from './helpers/events'

// Boris, 30.10.2026: «давай в боте также сделаем список команд по кнопке, тест там и другие».

const { db, close } = openTestDb()
afterAll(close)

const BORIS = 111
const FORUM = -1001234567890
const STRANGER = 333
const PULT = 'https://sara.example.test'

let tg: FakeTelegram
let bot: TelegramRuntime

async function until(cond: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}
const settle = () => new Promise((r) => setTimeout(r, 500))
const lastTo = (chat: number) => tg.sent.filter((m) => m.chat_id === chat).at(-1)
const buttonOf = (m: (typeof tg.sent)[number] | undefined) =>
  m?.reply_markup?.inline_keyboard[0]?.[0] as
    | { text: string; url?: string; web_app?: { url: string } }
    | undefined

/** Boris's command in his chat, answered once the bot replied to it. */
async function command(text: string) {
  const before = tg.sent.filter((m) => m.chat_id === BORIS).length
  tg.pushText(BORIS, text)
  await until(() => tg.sent.filter((m) => m.chat_id === BORIS).length > before)
  return lastTo(BORIS)
}

async function startBot(publicUrl: string | null = PULT) {
  bot = createTelegramRuntime({
    token: tg.token,
    apiRoot: tg.apiRoot,
    db,
    onPress: vi.fn(async () => 'ok'),
    onMessage: vi.fn(async () => 'ок'),
    publicUrl: publicUrl ?? undefined,
  })
  await bot.start()
}

beforeEach(async () => {
  await resetDb(db)
  await setSetting(db, 'cards.quiet_hours', null, 'system')
  tg = await createFakeTelegram()
  await startBot()
  tg.pushStart(BORIS)
  await until(() => tg.sent.length === 1)
})
afterEach(async () => {
  await bot.stop()
  await tg.close()
})

describe('the commands under the menu button', () => {
  it('ST-M7-17: at start the bot publishes its commands and puts the list on the menu button', async () => {
    const commands = tg.calls.find((c) => c.method === 'setMyCommands')?.params.commands
    expect(commands).toEqual(COMMANDS.map((c) => ({ command: c.name, description: c.description })))
    expect((commands as { command: string }[]).map((c) => c.command)).toEqual([
      'status',
      'queue',
      'test',
      'test_clear',
      'pause',
      'resume',
      'pult',
      'forum',
      'forum_off',
      'help',
    ])
    expect(tg.calls.filter((c) => c.method === 'setChatMenuButton').map((c) => c.params)).toEqual([
      { menu_button: { type: 'commands' } },
    ])
    // Restarted with Boris's chat bound: his chat gets the list too, over any button set for it alone.
    await bot.stop()
    tg.calls.length = 0
    await startBot()
    expect(tg.calls.filter((c) => c.method === 'setChatMenuButton').map((c) => c.params)).toEqual([
      { menu_button: { type: 'commands' } },
      { chat_id: BORIS, menu_button: { type: 'commands' } },
    ])
  })

  it('ST-M7-17: /help lists every command with its line', async () => {
    expect((await command('/help'))?.text).toBe(helpText())
    expect(helpText()).toContain('/pause: Пауза: не пишу клиентам и не трачу деньги')
  })

  it('ST-M7-17: /pause stops writing to clients and spending, and says so; /resume says what is off and where', async () => {
    await setSetting(db, 'outbound.messages', true, 'system')
    await setSetting(db, 'outbound.bids', true, 'system')
    expect((await command('/pause'))?.text).toBe(COMMAND_TEXTS.paused)
    expect(await getSetting(db, 'outbound.messages')).toBe(false)
    expect(await getSetting(db, 'outbound.bids')).toBe(false)
    expect(await countEvents(db, 'setting.changed')).toBeGreaterThanOrEqual(2)
    const resumed = await command('/resume')
    expect(resumed?.text).toMatch(
      /^Сейчас на паузе: не пишу клиентам, не трачу деньги на отклики\./,
    )
    // Nothing is turned on from the bot: that stays the pult's step.
    expect(await getSetting(db, 'outbound.messages')).toBe(false)
    expect(buttonOf(resumed)).toEqual({
      text: 'Открыть пульт',
      web_app: { url: `${PULT}/settings` },
    })
  })

  it('ST-M7-17: /resume with nothing paused says so', async () => {
    await setSetting(db, 'outbound.messages', true, 'system')
    await setSetting(db, 'outbound.bids', true, 'system')
    expect((await command('/resume'))?.text).toBe(COMMAND_TEXTS.notPaused)
  })

  it('ST-M7-17: /pult opens the pult as the Mini App in his chat', async () => {
    const m = await command('/pult')
    expect(m?.text).toBe(COMMAND_TEXTS.pult)
    expect(buttonOf(m)).toEqual({ text: 'Открыть пульт', web_app: { url: PULT } })
  })

  it('ST-M7-17: without the pult’s address /pult says so', async () => {
    await bot.stop()
    await startBot(null)
    expect((await command('/pult'))?.text).toBe(COMMAND_TEXTS.noPult)
  })

  it('ST-M7-17: /status gives the day in a few lines', async () => {
    await setSetting(db, 'outbound.messages', false, 'system')
    const text = (await command('/status'))?.text ?? ''
    expect(text).toMatch(/^Сейчас: /)
    expect(text).toContain('Ждёт тебя: заявок 0, черновиков 0, вопросов 0')
    expect(text).toContain('Кошелёк: пока не знаю')
    expect(text).toContain('На паузе: не пишу клиентам')
  })

  it('ST-M7-17: /queue lists the leads that wait, with the pult’s queue under them', async () => {
    expect((await command('/queue'))?.text).toBe(COMMAND_TEXTS.queueEmpty)
    await db.insert(lead).values({
      id: '95147898',
      accountId: 'hance-marketing',
      title: 'Стратегия для клиники',
      category: 'Маркетинг',
      city: 'Краснодар',
      text: 'Нужна стратегия',
      clientName: 'Анна',
      bidPriceRub: 210,
      seenAt: new Date().toISOString(),
      correlationId: newEventId(),
    })
    await db.insert(task).values({
      id: newEventId(),
      kind: 'lead_decision',
      entityKind: 'lead',
      entityId: '95147898',
    })
    const m = await command('/queue')
    expect(m?.text).toContain('Ждут решения: 1')
    expect(m?.text).toContain(
      `1. Стратегия для клиники · без балла · отклик ${formatRub(210)} · №95147898`,
    )
    expect(buttonOf(m)?.web_app).toEqual({ url: `${PULT}/leads` })
  })

  it('ST-M7-17: /test and /test_clear wait for the test stand', async () => {
    expect((await command('/test'))?.text).toBe(COMMAND_TEXTS.soon)
    expect((await command('/test_clear'))?.text).toBe(COMMAND_TEXTS.soon)
  })

  it('ST-M7-17: in the forum the commands answer in the topic they were written in, the pult as a link', async () => {
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: '/forum' })
    await until(async () => (await forumOf(db)) !== null)
    const thread = tg.topics[0]?.message_thread_id
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: '/pult', thread })
    await until(() => lastTo(FORUM)?.text === COMMAND_TEXTS.pult)
    expect(lastTo(FORUM)?.message_thread_id).toBe(thread)
    // A group takes no Mini App button: the pult opens as a link there.
    expect(buttonOf(lastTo(FORUM))).toEqual({ text: 'Открыть пульт', url: PULT })
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: '/help@sara_dev_bot' })
    await until(() => lastTo(FORUM)?.text === helpText())
  })

  it('T9: a command from someone else in the forum does nothing', async () => {
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: '/forum' })
    await until(async () => (await forumOf(db)) !== null)
    await setSetting(db, 'outbound.messages', true, 'system')
    const before = tg.sent.length
    tg.pushGroupText({ chatId: FORUM, fromId: STRANGER, text: '/pause' })
    await settle()
    expect(tg.sent).toHaveLength(before)
    expect(await getSetting(db, 'outbound.messages')).toBe(true)
  })
})
