import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../../tests/fakes/telegramApi'
import { lead, telegramCard } from '../../src/db/schema'
import { type LeadCard, TEXTS } from '../../src/notify/cards'
import { forumOf } from '../../src/notify/forum'
import { createTelegramRuntime, type TelegramRuntime } from '../../src/notify/telegram'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'

// FR-NOTIF-6, docs/superpowers/specs/2026-11-11-lead-card-widget.md: one picture card per lead, changed in place.

const { db, close } = openTestDb()
afterAll(close)

const BORIS = 111
const FORUM = -1001234567890
const taskId = '0192f3c4-5b6a-7c8d-9e0f-112233445566'
const otherTask = '0192f3c4-5b6a-7c8d-9e0f-998877665544'
const CARD: LeadCard = {
  taskId,
  orderId: '90001',
  title: 'Сайт для салона красоты',
  city: 'Краснодар',
  budgetText: null,
  clientName: 'Ирина',
  text: 'Нужен сайт для салона, с записью онлайн.',
  verdict: 'fit',
  reason: 'Сайт',
  bidPriceRub: 210,
}

let tg: FakeTelegram
let bot: TelegramRuntime
const onPress = vi.fn(async () => 'Отправляю отклик')

async function until(cond: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}
const nb = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ')
const texts = (i = -1) =>
  (tg.photos.at(i)?.reply_markup?.inline_keyboard ?? []).map((r) =>
    r.map((b) => nb(String(b.text))),
  )
const isPng = (b: Buffer | undefined) => b?.subarray(1, 4).toString('latin1') === 'PNG'
const stateOf = async (ref: number) =>
  (await db.select().from(telegramCard).where(eq(telegramCard.ref, ref)))[0]?.state as
    | Record<string, unknown>
    | undefined

async function bindChat() {
  tg.pushStart(BORIS)
  await until(() => tg.sent.length === 1)
}

beforeEach(async () => {
  await resetDb(db)
  await setSetting(db, 'cards.quiet_hours', null, 'system')
  await db.insert(lead).values({
    id: '90001',
    accountId: 'hance-marketing',
    title: 'Сайт для салона красоты',
    category: 'Сайты',
    city: 'Краснодар',
    text: 'Нужен сайт для салона, с записью онлайн.',
    clientName: 'Ирина',
    bidPriceRub: 210,
    seenAt: new Date().toISOString(),
    correlationId: newEventId(),
  })
  onPress.mockClear()
  tg = await createFakeTelegram()
  bot = createTelegramRuntime({ token: tg.token, apiRoot: tg.apiRoot, db, onPress })
  await bot.start()
})
afterEach(async () => {
  await bot.stop()
  await tg.close()
})

describe('the lead card as a picture', () => {
  it('FR-NOTIF-6: off by default: the text card with its buttons, as before', async () => {
    await bindChat()
    await bot.notifier.sendLeadCard(CARD)
    expect(tg.photos).toHaveLength(0)
    expect(tg.sent.at(-1)?.reply_markup?.inline_keyboard[0]?.[0]?.text).toContain('Откликнуться')
  })

  it('FR-NOTIF-6: on, the card is one picture with its buttons, no text under it, and nothing else is sent', async () => {
    await bindChat()
    await setSetting(db, 'cards.picture', true, 'boris')
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    expect(tg.photos).toHaveLength(1)
    const p = tg.photos[0]
    expect(p).toMatchObject({ chat_id: BORIS, message_id: messageId })
    expect(isPng(p?.photo)).toBe(true)
    expect(p?.caption).toBeUndefined()
    expect(texts()).toEqual([['Отправить отклик · 210 ₽'], ['Правка', 'Разбор', 'Пропустить']])
    expect(tg.sent).toHaveLength(1)
    const [row] = await db.select().from(telegramCard).where(eq(telegramCard.ref, messageId))
    expect(row).toMatchObject({ taskId, state: { s: 'new' } })
  })

  it('FR-NOTIF-6: with a forum the picture goes where the cards go, the topic of new orders', async () => {
    await bindChat()
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: '/forum' })
    await until(async () => (await forumOf(db)) !== null)
    await setSetting(db, 'cards.picture', true, 'boris')
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    expect(tg.photos[0]).toMatchObject({
      chat_id: FORUM,
      message_thread_id: (await forumOf(db))?.leadsThreadId,
    })
    expect(messageId).toBeLessThan(0)
  })

  it('FR-NOTIF-6: a picture Telegram refuses leaves the text card, once', async () => {
    await bindChat()
    await setSetting(db, 'cards.picture', true, 'boris')
    tg.setPhotoRefused('Bad Request: PHOTO_INVALID_DIMENSIONS')
    await bot.notifier.sendLeadCard(CARD)
    expect(tg.photos).toHaveLength(0)
    const cards = tg.sent.filter((m) => m.reply_markup)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.reply_markup?.inline_keyboard[0]?.[0]?.text).toContain('Откликнуться')
  })

  it('FR-NOTIF-6: the card changes in place: sending, sent, closed, without a new message', async () => {
    await bindChat()
    await setSetting(db, 'cards.picture', true, 'boris')
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    await bot.notifier.editText?.(messageId, '⏳ Отправляю отклик', [], {
      html: true,
      state: { s: 'sending' },
    })
    expect(tg.mediaEdits.at(-1)?.reply_markup).toEqual({ inline_keyboard: [] })
    await bot.notifier.editText?.(messageId, '✅ Отклик отправлен', [], {
      html: true,
      state: { s: 'sent', f: '210 ₽', t: '14:05', u: 'https://t.me/c/1/2' },
    })
    expect(texts()).toEqual([['Чат с клиентом', 'Открыть на Профи']])
    await bot.notifier.closeLeadCard(messageId, {
      ...CARD,
      closed: {
        since: '2026-11-11T10:00:00.000Z',
        published: true,
        at: '2026-11-11T10:40:00.000Z',
        exact: true,
        openUntil: null,
      },
    })
    expect(await stateOf(messageId)).toMatchObject({
      s: 'closed',
      n: 'закрылась через 40 мин после публикации',
    })
    expect(tg.mediaEdits).toHaveLength(3)
    expect(tg.mediaEdits.every((e) => isPng(e.photo))).toBe(true)
    expect(tg.photos).toHaveLength(1)
    expect(tg.sent).toHaveLength(1)
    expect(tg.edited).toHaveLength(0)
  })

  it('FR-NOTIF-6: a bid that did not go puts the card back as new, with the fee the site shows now', async () => {
    await bindChat()
    await setSetting(db, 'cards.picture', true, 'boris')
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    await bot.notifier.editText?.(messageId, 'x', [], { state: { s: 'sending' } })
    await bot.notifier.restoreLeadCard?.(messageId, { ...CARD, bidPriceRub: 55 })
    expect(texts()[0]).toEqual(['Отправить отклик · 55 ₽'])
    expect(await stateOf(messageId)).toMatchObject({ s: 'new' })
  })

  it('FR-NOTIF-6: a card Boris skipped says why and keeps the reason buttons under it', async () => {
    await bindChat()
    await setSetting(db, 'cards.picture', true, 'boris')
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    await bot.notifier.closeLeadCard(messageId, {
      ...CARD,
      closedByBoris: true,
      closeReason: {
        text: 'не мой профиль',
        by: 'guess',
        buttons: [{ text: 'Не мой профиль', callbackData: `r:${taskId}:1` }],
      },
    })
    expect(await stateOf(messageId)).toMatchObject({ s: 'skipped', n: 'Похоже, не мой профиль' })
    expect(texts()).toEqual([['Не мой профиль'], ['Открыть на Профи']])
  })

  it('FR-NOTIF-6: a card decided in the pult is marked only while it still offers its buttons', async () => {
    await bindChat()
    await setSetting(db, 'cards.picture', true, 'boris')
    const first = await bot.notifier.sendLeadCard(CARD)
    await bot.notifier.markDone?.(first.messageId, 'Решено в приложении: отклик')
    expect(await stateOf(first.messageId)).toMatchObject({ s: 'done' })
    const second = await bot.notifier.sendLeadCard({ ...CARD, taskId: otherTask })
    await bot.notifier.editText?.(second.messageId, 'x', [], { state: { s: 'sent' } })
    await bot.notifier.markDone?.(second.messageId, 'Решено в приложении: отклик')
    expect(await stateOf(second.messageId)).toMatchObject({ s: 'sent' })
  })

  it('FR-NOTIF-6: one live card per lead: when it comes again (after «Правка»), the older one says so', async () => {
    await bindChat()
    await setSetting(db, 'cards.picture', true, 'boris')
    const first = await bot.notifier.sendLeadCard(CARD)
    await bot.notifier.sendLeadCard({ ...CARD, draft: { text: 'Новый текст', priceRub: 5000 } })
    expect(tg.photos).toHaveLength(2)
    expect(await stateOf(first.messageId)).toEqual({ s: 'note', n: TEXTS.cardMoved })
    expect(texts(0)).toEqual([])
  })

  it('FR-NOTIF-6: a text card stays a text card: its edits are text edits even with pictures on', async () => {
    await bindChat()
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    await setSetting(db, 'cards.picture', true, 'boris')
    await bot.notifier.editText?.(messageId, '⏳ Отправляю отклик', [], {
      html: true,
      state: { s: 'sending' },
    })
    expect(tg.edited.at(-1)?.text).toBe('⏳ Отправляю отклик')
    expect(tg.mediaEdits).toHaveLength(0)
  })
})
