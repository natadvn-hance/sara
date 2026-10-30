import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../tests/fakes/telegramApi'
import { boundChat } from '../src/notify/binding'
import { createBotControl } from '../src/notify/botControl'
import { type LeadCard, TEXTS } from '../src/notify/cards'
import { createTelegramRuntime, type TelegramRuntime } from '../src/notify/telegram'
import { getMe } from '../src/notify/telegramApi'
import { setSetting } from '../src/settings/store'
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
const CARD: LeadCard = {
  taskId,
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
const DASH = String.fromCharCode(0x2014)
const EN_DASH = String.fromCharCode(0x2013)

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
    await bot.notifier.sendLeadCard(CARD)
    expect(tg.sent[1]?.chat_id).toBe(111)
    expect(tg.sent[1]?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data).toBe(`t:${taskId}:bid`)
    expect(tg.sent[1]?.reply_markup?.inline_keyboard[1]?.map((b) => b.callback_data)).toEqual([
      `t:${taskId}:razbor`,
      `t:${taskId}:edit`,
      `t:${taskId}:skip`,
    ])
  })

  it('FR-LEAD-7: the lead card goes as Telegram HTML with link previews off', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    await bot.notifier.sendLeadCard(CARD)
    expect(tg.sent[1]).toMatchObject({
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    })
    expect(tg.sent[1]?.text).toContain('<b>🔔 Сайт</b>')
    expect(tg.sent[1]?.text).toContain('<a href="https://profi.ru/backoffice/n.php?o=90001">')
  })

  it('FR-LEAD-7: a client text with tags and an ampersand reaches Telegram escaped, and Telegram takes it', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    await bot.notifier.sendLeadCard({
      ...CARD,
      title: 'Сайт <b>&</b>',
      text: 'Нужно <script>alert(1)</script> & "всё" > 5',
      clientName: 'Ира <i>',
    })
    expect(tg.sent[1]?.text).toContain('<b>🔔 Сайт &lt;b&gt;&amp;&lt;/b&gt;</b>')
    expect(tg.sent[1]?.text).toContain(
      '<blockquote expandable>Нужно &lt;script&gt;alert(1)&lt;/script&gt; &amp; "всё" &gt; 5</blockquote>',
    )
    expect(tg.sent[1]?.text).toContain('👤 <b>Ира &lt;i&gt;</b>')
  })

  it('FR-LEAD-7: a very long order text still goes in one message of at most 4096 characters', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    await bot.notifier.sendLeadCard({ ...CARD, text: 'Очень длинная заявка. '.repeat(1000) })
    expect(tg.sent).toHaveLength(2)
    expect(tg.sent[1]?.text).toContain('…</blockquote>')
  })

  it('FR-LEAD-7: should Telegram refuse the markup, the card still comes as plain text', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    tg.setRejectHtml(true)
    await bot.notifier.sendLeadCard({ ...CARD, text: 'Нужен <сайт> & всё' })
    const m = tg.sent[1]
    expect(m?.parse_mode).toBeUndefined()
    expect(m?.text).not.toMatch(/<\/?(b|i|a|blockquote)\b/)
    expect(m?.text).toContain('Нужен <сайт> & всё')
    expect(m?.text).toContain('https://profi.ru/backoffice/n.php?o=90001')
    expect(m?.reply_markup?.inline_keyboard.flat().length).toBe(4)
    expect(m?.link_preview_options).toEqual({ is_disabled: true })
  })

  it('FR-LEAD-7: should Telegram refuse the markup of a card at the limit, the plain text still fits 4096', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    tg.setRejectHtml(true)
    await bot.notifier.sendLeadCard({ ...CARD, text: 'a '.repeat(9000) })
    const m = tg.sent[1]
    expect(m?.parse_mode).toBeUndefined()
    expect(m?.text.length).toBeLessThanOrEqual(4096)
    expect(m?.text.endsWith('https://profi.ru/backoffice/n.php?o=90001')).toBe(true)
    expect(m?.link_preview_options).toEqual({ is_disabled: true })
  })

  it('FR-LEAD-5: the card of a closed order is edited in place into the short closed card, the buttons go', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    await bot.notifier.closeLeadCard(messageId, CARD)
    expect(tg.edited).toHaveLength(1)
    const e = tg.edited[0]
    expect(e).toMatchObject({
      chat_id: 111,
      message_id: messageId,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [] },
    })
    expect(e?.text.startsWith(`<b>${TEXTS.closedCard}</b> · Сайт`)).toBe(true)
    expect(e?.text).toContain(
      `<a href="https://profi.ru/backoffice/n.php?o=90001">${TEXTS.closedLink}</a>`,
    )
    expect(e?.text).not.toContain('🔔')
    // No new message came.
    expect(tg.sent).toHaveLength(2)
  })

  it('FR-LEAD-5: the closed card of a very long order is short: the order text is gone', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    const long = { ...CARD, text: 'Очень длинная заявка. '.repeat(1000) }
    const { messageId } = await bot.notifier.sendLeadCard(long)
    await bot.notifier.closeLeadCard(messageId, long)
    expect(tg.edited).toHaveLength(1)
    expect(tg.edited[0]?.text).not.toContain('Очень длинная заявка')
    expect(tg.edited[0]?.text.length).toBeLessThan(300)
  })

  it('FR-LEAD-5: should Telegram refuse the markup, the closed card is edited as plain text, buttons gone', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    tg.setRejectHtml(true)
    await bot.notifier.closeLeadCard(messageId, CARD)
    expect(tg.edited).toHaveLength(1)
    expect(tg.edited[0]?.parse_mode).toBeUndefined()
    expect(tg.edited[0]?.text).toContain(TEXTS.closedCard)
    expect(tg.edited[0]?.text).toContain('https://profi.ru/backoffice/n.php?o=90001')
    expect(tg.edited[0]?.text).not.toMatch(/<\/?(b|i|a|blockquote)\b/)
    expect(tg.edited[0]?.reply_markup).toEqual({ inline_keyboard: [] })
  })

  it('FR-LEAD-5: a message Telegram will not edit (deleted, or already closed) is logged, never thrown', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    tg.setEditError(messageId, 'message to edit not found')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(bot.notifier.closeLeadCard(messageId, CARD)).resolves.toBeUndefined()
      expect(log).toHaveBeenCalled()
      expect(tg.edited).toHaveLength(0)
      // «message is not modified»: the same closing a second time.
      tg.setEditError(messageId, null)
      await bot.notifier.closeLeadCard(messageId, CARD)
      expect(tg.edited).toHaveLength(1)
      await expect(bot.notifier.closeLeadCard(messageId, CARD)).resolves.toBeUndefined()
      expect(tg.edited).toHaveLength(1)
    } finally {
      log.mockRestore()
    }
  })

  it('FR-NOTIF-2: a silent lead card goes with disable_notification, a usual one without', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    // Outside the quiet hours, whatever the clock of the run.
    await setSetting(db, 'cards.quiet_hours', null, 'boris')
    await bot.notifier.sendLeadCard(CARD, { silent: true })
    await bot.notifier.sendLeadCard(CARD)
    expect(tg.sent[1]?.disable_notification).toBe(true)
    expect(tg.sent[2]?.disable_notification).toBeUndefined()
  })

  it('NFR-UX-1: no long dash reaches Boris, whatever text the model or the order brought', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    await bot.notifier.sendText(`Почему: клиент ${DASH} сеть клиник`)
    await bot.notifier.sendButtons(`Бюджет 10${EN_DASH}20 тысяч, а не ${EN_DASH} 5`, [
      [{ text: 'Применить', callbackData: `t:${taskId}:apply` }],
    ])
    await bot.notifier.sendLeadCard({
      ...CARD,
      title: `Сайт${DASH}лендинг`,
      verdict: null,
      reason: null,
      score: { value: 70, version: 2, reason: `Зрелый бизнес ${DASH} понятная задача` },
      draft: { text: `Добрый день!\n\nСайт ${DASH} это просто`, priceRub: null },
    })
    onPress.mockResolvedValueOnce(`Готово ${DASH} отклик ушёл`)
    tg.pushPress(111, `t:${taskId}:bid`)
    await until(() => tg.answers.length === 1)
    expect(tg.sent[1]?.text).toBe('Почему: клиент - сеть клиник')
    expect(tg.sent[2]?.text).toBe('Бюджет 10-20 тысяч, а не - 5')
    expect(tg.sent[3]?.text.split('\n')).toEqual([
      '<b>🔔 Сайт-лендинг</b>',
      '📍 Краснодар',
      '🎯 <b>балл 70</b>  ·  💰 бюджет не указан  ·  🧾 отклик 210\u00a0₽',
      '',
      '👤 <b>Ирина</b>',
      '',
      '<b>Почему подходит</b>',
      '➕ Зрелый бизнес - понятная задача',
      '',
      '<b>✍️ Отклик</b>',
      '<blockquote>Добрый день!',
      '',
      'Сайт - это просто</blockquote>',
      'Стоимость услуги: не указана. Без неё Профи.ру отклик не примет: пришли её через «Изменить» отдельной строкой, например «цена 5000».',
      '',
      '<b>📄 Текст заявки</b>',
      '<blockquote expandable>Нужен сайт</blockquote>',
      '',
      '<a href="https://profi.ru/backoffice/n.php?o=90001">Открыть заявку на Профи.ру</a>',
    ])
    expect(tg.answers[0]?.text).toBe('Готово - отклик ушёл')
  })

  it('NFR-UX-1: the dash replacement leaves HTML tags and entities whole', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    const html = [
      `<b>Сайт ${DASH} лендинг</b> &amp; &lt;i&gt; ${EN_DASH} &quot;q&quot;`,
      `<a href="https://example.ru/a${DASH}b?x=1&amp;y=2">ссылка ${DASH} тут</a>`,
      `<blockquote expandable>строка ${DASH} раз\nстрока ${EN_DASH} два</blockquote>`,
    ].join('\n')
    await bot.notifier.sendText(html, { html: true })
    expect(tg.sent[1]?.parse_mode).toBe('HTML')
    expect(tg.sent[1]?.text).toBe(
      [
        '<b>Сайт - лендинг</b> &amp; &lt;i&gt; - &quot;q&quot;',
        `<a href="https://example.ru/a${DASH}b?x=1&amp;y=2">ссылка - тут</a>`,
        '<blockquote expandable>строка - раз\nстрока - два</blockquote>',
      ].join('\n'),
    )
  })

  it('NFR-UX-1: a dash written as a numeric entity in HTML becomes a hyphen too', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    await bot.notifier.sendText(
      '<b>раз &#8212; два &#x2014; три &#X2013; четыре &#8211; пять</b> &#169;',
      {
        html: true,
      },
    )
    expect(tg.sent[1]?.text).toBe('<b>раз - два - три - четыре - пять</b> &#169;')
  })

  it('NFR-UX-1: text without a parse mode is not read as HTML: angle brackets stay, dashes go', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    await bot.notifier.sendText(`a <b> ${DASH} &#8212; c`)
    expect(tg.sent[1]?.parse_mode).toBeUndefined()
    expect(tg.sent[1]?.text).toBe('a <b> - &#8212; c')
  })

  it('FR-OPS-2: another program polling the same bot does not crash the core and is reported', async () => {
    await bot.stop()
    tg.setConflict(true)
    const control = createBotControl({ db, apiRoot: tg.apiRoot, onPress })
    await control.start(tg.token).catch(() => {})
    const end = Date.now() + 3000
    while (Date.now() < end && !control.lastError()) await new Promise((r) => setTimeout(r, 50))
    expect(control.lastError()).toMatch(/другая программа/)
    await control.stop()
    tg.setConflict(false)
    bot = createTelegramRuntime({ token: tg.token, apiRoot: tg.apiRoot, db, onPress })
    await bot.start()
  })

  it('FR-SET-2: getMe tells a working token from an unknown one', async () => {
    expect(await getMe(tg.token, tg.apiRoot)).toEqual({ ok: true, username: 'sara_dev_bot' })
    expect(await getMe('123:wrong', tg.apiRoot)).toEqual({ ok: false, reason: 'unauthorized' })
    expect(await getMe(tg.token, 'http://127.0.0.1:1')).toEqual({ ok: false, reason: 'network' })
  })
})
