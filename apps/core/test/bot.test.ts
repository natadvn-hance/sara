import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../tests/fakes/telegramApi'
import { boundChat } from '../src/notify/binding'
import { createTelegramRuntime, type TelegramRuntime } from '../src/notify/telegram'
import { getMe } from '../src/notify/telegramApi'
import { openTestDb, resetDb } from './helpers/db'
import { countEvents } from './helpers/events'

const { db, close } = openTestDb()
afterAll(close)

let tg: FakeTelegram
let bot: TelegramRuntime
const onPress = vi.fn(async () => 'Отправляю отклик')

async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}
const settle = () => new Promise((r) => setTimeout(r, 500))
const taskId = '0192f3c4-5b6a-7c8d-9e0f-112233445566'

beforeEach(async () => {
  await resetDb(db)
  onPress.mockClear()
  tg = await createFakeTelegram()
  bot = createTelegramRuntime({ token: tg.token, apiRoot: tg.apiRoot, db, onPress })
  await bot.start()
})
afterEach(async () => {
  await bot.stop()
  await tg.close()
})

describe('telegram bot', () => {
  it('FR-SET-2: first /start binds the chat and says hello', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    expect(tg.sent[0]).toMatchObject({ chat_id: 111, text: 'Сара на связи' })
    expect(await boundChat(db)).toBe(111)
    expect(await countEvents(db, 'telegram.bound')).toBe(1)
  })

  it('T9: /start from another chat after binding does not rebind', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    tg.pushStart(222)
    await settle()
    expect(await boundChat(db)).toBe(111)
    expect(tg.sent).toHaveLength(1)
    expect(await countEvents(db, 'security.foreign_chat')).toBe(1)
  })

  it('T9: press from a foreign chat does nothing and is logged', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    tg.pushPress(222, `t:${taskId}:bid`)
    await settle()
    expect(onPress).not.toHaveBeenCalled()
    expect(await countEvents(db, 'security.foreign_chat')).toBe(1)
  })

  it('FR-NOTIF-1: press from the bound chat reaches onPress and is answered', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    const id = tg.pushPress(111, `t:${taskId}:bid`)
    await until(() => tg.answers.length === 1)
    expect(onPress).toHaveBeenCalledWith({ taskId, action: 'bid' })
    expect(tg.answers[0]).toMatchObject({ callback_query_id: id, text: 'Отправляю отклик' })
  })

  it('FR-NOTIF-1: lead card goes to the bound chat with buttons', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    await bot.notifier.sendLeadCard({
      taskId,
      title: 'Сайт',
      city: 'Краснодар',
      verdict: 'fit',
      reason: 'Сайт',
      bidPriceRub: 210,
    })
    expect(tg.sent[1]?.chat_id).toBe(111)
    expect(tg.sent[1]?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data).toBe(`t:${taskId}:bid`)
  })

  it('FR-SET-2: getMe tells a working token from an unknown one', async () => {
    expect(await getMe(tg.token, tg.apiRoot)).toEqual({ ok: true, username: 'sara_dev_bot' })
    expect(await getMe('123:wrong', tg.apiRoot)).toEqual({ ok: false, reason: 'unauthorized' })
    expect(await getMe(tg.token, 'http://127.0.0.1:1')).toEqual({ ok: false, reason: 'network' })
  })
})
