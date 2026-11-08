import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../tests/fakes/telegramApi'
import type { LeadCard } from '../src/notify/cards'
import { createTelegramRuntime, type TelegramRuntime } from '../src/notify/telegram'
import { setSetting } from '../src/settings/store'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)

let tg: FakeTelegram
let bot: TelegramRuntime

async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}
const CARD: LeadCard = {
  taskId: '0192f3c4-5b6a-7c8d-9e0f-112233445566',
  orderId: '90001',
  title: 'Сайт',
  city: 'Краснодар',
  budgetText: null,
  clientName: 'Ирина',
  text: 'Нужен сайт',
  verdict: 'fit',
  reason: 'Сайт',
  bidPriceRub: 210,
}

beforeEach(async () => {
  await resetDb(db)
  tg = await createFakeTelegram()
  bot = createTelegramRuntime({
    token: tg.token,
    apiRoot: tg.apiRoot,
    db,
    onPress: async () => 'ok',
  })
  await bot.start()
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
})
afterEach(async () => {
  await bot.stop()
  await tg.close()
})

/** One message of each kind the core sends on its own, in the order of the list. */
async function sendAll(loud = false) {
  await bot.notifier.sendText('⏸️ Лимит Claude кончился', { loud })
  await bot.notifier.sendText('✅ Отклик отправлен', { html: true, loud })
  await bot.notifier.sendButtons('Сводка', [[{ text: 'Взял бы №1', callbackData: 't:x:want' }]], {
    loud,
  })
  await bot.notifier.sendLeadCard(CARD)
}
const flags = () => tg.sent.slice(1).map((m) => m.disable_notification)

describe('quiet hours of every notification', () => {
  it('FR-NOTIF-2: at quiet hours a text, an HTML text, buttons and a card all come without sound', async () => {
    // Equal hours: quiet all day, whatever the clock of the run.
    await setSetting(db, 'cards.quiet_hours', { from: 4, to: 4 }, 'boris')
    await sendAll()
    expect(flags()).toEqual([true, true, true, true])
  })

  it('FR-SPEECH-5: buttons sent as quiet have no sound at any hour', async () => {
    await setSetting(db, 'cards.quiet_hours', null, 'boris')
    await bot.notifier.sendButtons('Разбор', [[{ text: 'В образцы', callbackData: 't:x:apply' }]], {
      quiet: true,
    })
    expect(flags()).toEqual([true])
  })

  it('FR-NOTIF-2: outside quiet hours they come with sound', async () => {
    await setSetting(db, 'cards.quiet_hours', null, 'boris')
    await sendAll()
    expect(flags()).toEqual([undefined, undefined, undefined, undefined])
  })

  it('FR-NOTIF-2: an urgent message keeps its sound at quiet hours', async () => {
    await setSetting(db, 'cards.quiet_hours', { from: 4, to: 4 }, 'boris')
    await sendAll(true)
    expect(flags()).toEqual([undefined, undefined, undefined, true])
  })
})
