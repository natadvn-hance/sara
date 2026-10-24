import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../tests/fakes/telegramApi'
import { leadLabel, question } from '../src/db/schema'
import { seedDirection } from '../src/direction/store'
import { handleBorisMessage } from '../src/learning/inbox'
import { recordLabel } from '../src/learning/labels'
import { askWhy } from '../src/learning/questions'
import { createTelegramRuntime, type TelegramRuntime } from '../src/notify/telegram'
import { openTestDb, resetDb } from './helpers/db'
import { countEvents } from './helpers/events'
import { leadWithScore } from './helpers/learning'

const { db, close } = openTestDb()
afterAll(close)

let tg: FakeTelegram
let bot: TelegramRuntime
let heard: string | null = 'бюджет копейки'
const transcribe = vi.fn(async () => heard)
const onMessage = vi.fn((m: Parameters<typeof handleBorisMessage>[1]) =>
  handleBorisMessage({ db, transcriber: { transcribe } }, m),
)

async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}
const said = (t: string) => tg.sent.some((m) => m.text === t)

/** Boris is bound, and Sara asked why he skipped lead 920001. Returns the question's message id. */
async function asked(): Promise<number> {
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await leadWithScore(db, '920001', 80)
  await recordLabel(db, { leadId: '920001', label: 'no', source: 'card' })
  await askWhy(
    { db, notifier: bot.notifier },
    { kind: 'why_skip', entityId: '920001', title: 'Реклама на ТВ' },
    new Date(),
  )
  const [q] = await db.select().from(question)
  return q?.telegramMessageId ?? -1
}
const label = async () =>
  (await db.select().from(leadLabel).where(eq(leadLabel.leadId, '920001')))[0]

beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  heard = 'бюджет копейки'
  transcribe.mockClear()
  onMessage.mockClear()
  tg = await createFakeTelegram()
  bot = createTelegramRuntime({
    token: tg.token,
    apiRoot: tg.apiRoot,
    db,
    onPress: async () => 'ok',
    onMessage,
  })
  await bot.start()
})
afterEach(async () => {
  await bot.stop()
  await tg.close()
})

describe("Boris's words in the bot", () => {
  it("FR-LEAD-7: Boris's reply text to a question is noted", async () => {
    const q = await asked()
    tg.pushText(111, 'не наш профиль', q)
    await until(() => said('Записала: «не наш профиль»'))
    expect(await label()).toMatchObject({ reason: 'не наш профиль', voice: false })
  })

  it('FR-LEAD-7: a voice answer is recognized and noted, marked as voice', async () => {
    const q = await asked()
    tg.pushVoice(111, q)
    await until(() => said('Записала: «бюджет копейки»'))
    expect(transcribe).toHaveBeenCalledOnce()
    expect(await label()).toMatchObject({ reason: 'бюджет копейки', voice: true })
  })

  it('FR-LEAD-7: an unrecognized voice asks for text and notes nothing', async () => {
    const q = await asked()
    heard = null
    tg.pushVoice(111, q)
    await until(() => said('Не смогла разобрать голосовое, напиши текстом, пожалуйста'))
    expect((await label())?.reason).toBeNull()
  })

  it('FR-LEAD-7: a message that answers nothing gets «Пока я понимаю только ответы на мои вопросы»', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    tg.pushText(111, 'привет')
    await until(() => said('Пока я понимаю только ответы на мои вопросы'))
  })

  it('NFR-SEC-1: text and voice from a foreign chat are ignored and logged', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    tg.pushText(222, 'чужой')
    tg.pushVoice(222)
    await until(async () => (await countEvents(db, 'security.foreign_chat')) === 2)
    expect(onMessage).not.toHaveBeenCalled()
    expect(tg.sent).toHaveLength(1)
  })
})
