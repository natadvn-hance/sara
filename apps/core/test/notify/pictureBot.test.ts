import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../../tests/fakes/telegramApi'
import { cardImage, lead, telegramCard } from '../../src/db/schema'
import { registerCardImageRoutes } from '../../src/notify/cardImages'
import { type LeadCard, TEXTS } from '../../src/notify/cards'
import { createTelegramRuntime, type TelegramRuntime } from '../../src/notify/telegram'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'

// FR-NOTIF-6, docs/superpowers/specs/2026-11-11-lead-card-widget.md: one message per lead, a large picture above its
// text, changed in place.

const { db, close } = openTestDb()
afterAll(close)

const BORIS = 111
const SITE = 'https://sara.example'
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
  draft: { text: 'Добрый день, Ирина! Сделаю сайт с записью.', priceRub: 30000 },
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
type Shown = {
  link_preview_options?: { url?: string }
  reply_markup?: { inline_keyboard: { text: string }[][] }
}
const previewOf = (m: unknown) => (m as Shown | undefined)?.link_preview_options?.url ?? ''
const buttons = (m: unknown) =>
  ((m as Shown | undefined)?.reply_markup?.inline_keyboard ?? []).map((r) =>
    r.map((b) => nb(b.text)),
  )
const stateOf = async (ref: number) =>
  (await db.select().from(telegramCard).where(eq(telegramCard.ref, ref)))[0]?.state as
    | Record<string, unknown>
    | undefined

async function start(publicUrl?: string) {
  tg = await createFakeTelegram()
  bot = createTelegramRuntime({ token: tg.token, apiRoot: tg.apiRoot, db, onPress, publicUrl })
  await bot.start()
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
})
afterEach(async () => {
  await bot.stop()
  await tg.close()
})

describe('the lead card as a large picture above its text', () => {
  it('FR-NOTIF-6: off by default: the text card with its buttons, as before', async () => {
    await start(SITE)
    await bot.notifier.sendLeadCard(CARD)
    expect(previewOf(tg.sent.at(-1))).toBe('')
    expect(tg.sent.at(-1)?.reply_markup?.inline_keyboard[0]?.[0]?.text).toContain('Откликнуться')
  })

  it('FR-NOTIF-6: on, the card is one message: the picture large above its text, the buttons under it', async () => {
    await start(SITE)
    await setSetting(db, 'cards.picture', true, 'boris')
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    expect(tg.sent).toHaveLength(2)
    const m = tg.sent.at(-1)
    expect(m).toMatchObject({ chat_id: BORIS, message_id: messageId, parse_mode: 'HTML' })
    expect(m?.link_preview_options).toMatchObject({
      prefer_large_media: true,
      show_above_text: true,
    })
    expect(previewOf(m)).toMatch(/^https:\/\/sara\.example\/api\/card\/[A-Za-z0-9_-]{24}\.png$/)
    expect(m?.text).toContain(
      '<blockquote expandable>Нужен сайт для салона, с записью онлайн.</blockquote>',
    )
    expect(buttons(m)).toEqual([['Отправить отклик · 210 ₽'], ['Правка', 'Разбор', 'Пропустить']])
    const [row] = await db.select().from(telegramCard).where(eq(telegramCard.ref, messageId))
    expect(row).toMatchObject({ taskId, kind: 'text', state: { s: 'new' } })
  })

  it('FR-NOTIF-6: the picture of the preview is served at its address, nothing at any other', async () => {
    await start(SITE)
    await setSetting(db, 'cards.picture', true, 'boris')
    await bot.notifier.sendLeadCard(CARD)
    const path = previewOf(tg.sent.at(-1)).replace(SITE, '')
    const app = Fastify()
    registerCardImageRoutes(app, { db })
    const ok = await app.inject({ method: 'GET', url: path })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['content-type']).toBe('image/png')
    expect(ok.rawPayload.subarray(1, 4).toString('latin1')).toBe('PNG')
    for (const url of [
      '/api/card/AAAAAAAAAAAAAAAAAAAAAAAA.png',
      '/api/card/x.png',
      '/api/card/..%2Fsecret',
    ])
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404)
    expect(await db.select({ t: cardImage.token }).from(cardImage)).toHaveLength(1)
    await app.close()
  })

  it('FR-NOTIF-6: without a public https address there is no picture card: the text card goes', async () => {
    await start('http://localhost:5173')
    await setSetting(db, 'cards.picture', true, 'boris')
    await bot.notifier.sendLeadCard(CARD)
    expect(previewOf(tg.sent.at(-1))).toBe('')
    expect(tg.sent.at(-1)?.reply_markup?.inline_keyboard[0]?.[0]?.text).toContain('Откликнуться')
  })

  it('FR-NOTIF-6: the card changes in place: sending, sent, closed, each with a picture at a new address', async () => {
    await start(SITE)
    await setSetting(db, 'cards.picture', true, 'boris')
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    const first = previewOf(tg.sent.at(-1))
    await bot.notifier.editText?.(messageId, '⏳ Отправляю отклик', [], {
      html: true,
      state: { s: 'sending' },
    })
    expect(tg.edited.at(-1)?.text).toContain('Отправляю отклик…')
    await bot.notifier.editText?.(messageId, '✅ Отклик отправлен', [], {
      html: true,
      state: { s: 'sent', f: '210 ₽', t: '14:05', u: 'https://t.me/c/1/2' },
    })
    expect(buttons(tg.edited.at(-1))).toEqual([['Чат с клиентом', 'Открыть на Профи']])
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
    expect(await stateOf(messageId)).toMatchObject({ s: 'closed' })
    const urls = [first, ...tg.edited.map((e) => previewOf(e))]
    expect(new Set(urls).size).toBe(4)
    expect(tg.sent).toHaveLength(2)
  })

  it('FR-NOTIF-6: a bid that did not go puts the card back as new, with the fee the site shows now', async () => {
    await start(SITE)
    await setSetting(db, 'cards.picture', true, 'boris')
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    await bot.notifier.editText?.(messageId, 'x', [], { state: { s: 'sending' } })
    await bot.notifier.restoreLeadCard?.(messageId, { ...CARD, bidPriceRub: 55 })
    expect(buttons(tg.edited.at(-1))[0]).toEqual(['Отправить отклик · 55 ₽'])
  })

  it('FR-NOTIF-6: a card Boris skipped keeps the reason buttons under it', async () => {
    await start(SITE)
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
    expect(buttons(tg.edited.at(-1))).toEqual([['Не мой профиль'], ['Открыть на Профи']])
  })

  it('FR-NOTIF-6: a card decided in the pult is marked only while it still offers its buttons', async () => {
    await start(SITE)
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
    await start(SITE)
    await setSetting(db, 'cards.picture', true, 'boris')
    const first = await bot.notifier.sendLeadCard(CARD)
    await bot.notifier.sendLeadCard({ ...CARD, draft: { text: 'Новый текст', priceRub: 5000 } })
    expect(await stateOf(first.messageId)).toEqual({ s: 'note', n: TEXTS.cardMoved })
  })

  it('FR-NOTIF-6: a text card stays a text card: its edits are text edits even with pictures on', async () => {
    await start(SITE)
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    await setSetting(db, 'cards.picture', true, 'boris')
    await bot.notifier.editText?.(messageId, '⏳ Отправляю отклик', [], {
      html: true,
      state: { s: 'sending' },
    })
    expect(tg.edited.at(-1)?.text).toBe('⏳ Отправляю отклик')
    expect(previewOf(tg.edited.at(-1))).toBe('')
  })
})
