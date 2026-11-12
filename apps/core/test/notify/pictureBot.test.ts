import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../../tests/fakes/telegramApi'
import { cardImage, lead, telegramCard } from '../../src/db/schema'
import { registerCardImageRoutes } from '../../src/notify/cardImages'
import {
  closedLeadCardText,
  type LeadCard,
  leadCardKeyboard,
  leadCardText,
} from '../../src/notify/cards'
import { createTelegramRuntime, type TelegramRuntime } from '../../src/notify/telegram'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'

// FR-NOTIF-6, docs/superpowers/specs/2026-11-11-lead-card-widget.md: the working text card with the header picture
// above it as a large link preview (Boris, 12.11.2026); every later state the old way.

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
type Shown = {
  link_preview_options?: { url?: string }
  reply_markup?: { inline_keyboard: { text: string }[][] }
}
const previewOf = (m: unknown) => (m as Shown | undefined)?.link_preview_options?.url ?? ''
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

describe('the lead card with its header picture', () => {
  it('FR-NOTIF-6: off by default: the text card with its buttons, as before', async () => {
    await start(SITE)
    await bot.notifier.sendLeadCard(CARD)
    expect(previewOf(tg.sent.at(-1))).toBe('')
    expect(tg.sent.at(-1)?.reply_markup?.inline_keyboard[0]?.[0]?.text).toContain('Откликнуться')
  })

  it('FR-NOTIF-6: on, the working text card goes with the header picture large above it', async () => {
    await start(SITE)
    await setSetting(db, 'cards.picture', true, 'boris')
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    expect(tg.sent).toHaveLength(2)
    const m = tg.sent.at(-1)
    expect(m).toMatchObject({
      chat_id: BORIS,
      message_id: messageId,
      parse_mode: 'HTML',
      text: leadCardText(CARD),
    })
    expect(m?.reply_markup).toEqual(JSON.parse(JSON.stringify(leadCardKeyboard(CARD))))
    expect(m?.link_preview_options).toMatchObject({
      prefer_large_media: true,
      show_above_text: true,
    })
    expect(previewOf(m)).toMatch(/^https:\/\/sara\.example\/api\/card\/[A-Za-z0-9_-]{24}\.png$/)
    expect(tg.photos).toHaveLength(0)
    expect(await db.select().from(telegramCard)).toHaveLength(0)
  })

  it('FR-NOTIF-6: the header is served at its address, nothing at any other', async () => {
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

  it('FR-NOTIF-6: without a public https address the card goes without its header', async () => {
    await start('http://localhost:5173')
    await setSetting(db, 'cards.picture', true, 'boris')
    await bot.notifier.sendLeadCard(CARD)
    expect(previewOf(tg.sent.at(-1))).toBe('')
    expect(tg.sent.at(-1)?.text).toBe(leadCardText(CARD))
  })

  it('FR-NOTIF-6: a card with its header changes the old way: the status, then the closed card', async () => {
    await start(SITE)
    await setSetting(db, 'cards.picture', true, 'boris')
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    await bot.notifier.editText?.(messageId, '⏳ Отправляю отклик', [], {
      html: true,
      state: { s: 'sending' },
    })
    expect(tg.edited.at(-1)).toMatchObject({
      message_id: messageId,
      text: '⏳ Отправляю отклик',
      link_preview_options: { is_disabled: true },
    })
    const closed: LeadCard = {
      ...CARD,
      closed: {
        since: '2026-11-11T10:00:00.000Z',
        published: true,
        at: '2026-11-11T10:40:00.000Z',
        exact: true,
        openUntil: null,
      },
    }
    await bot.notifier.closeLeadCard(messageId, closed)
    expect(tg.edited.at(-1)).toMatchObject({
      message_id: messageId,
      text: closedLeadCardText(closed),
    })
    expect(tg.mediaEdits).toHaveLength(0)
    expect(tg.sent).toHaveLength(2)
  })

  it('FR-NOTIF-6: a bid that did not go puts the card back as new, with a new header and the fee the site shows now', async () => {
    await start(SITE)
    await setSetting(db, 'cards.picture', true, 'boris')
    const { messageId } = await bot.notifier.sendLeadCard(CARD)
    const first = previewOf(tg.sent.at(-1))
    await bot.notifier.editText?.(messageId, 'x', [], { state: { s: 'sending' } })
    await bot.notifier.restoreLeadCard?.(messageId, { ...CARD, bidPriceRub: 55 })
    const back = tg.edited.at(-1)
    expect(back?.text).toBe(leadCardText({ ...CARD, bidPriceRub: 55 }))
    expect(previewOf(back)).toMatch(/^https:\/\/sara\.example\/api\/card\//)
    expect(previewOf(back)).not.toBe(first)
  })

  it('FR-NOTIF-6: a photo card of 11 and 12.11 still changes as a picture, a text one of 12.11 the old way', async () => {
    await start(SITE)
    const photo = await bot.notifier.sendLeadCard(CARD)
    await db
      .insert(telegramCard)
      .values({ ref: photo.messageId, taskId, card: CARD, state: { s: 'new' }, kind: 'photo' })
    // The photo Telegram keeps behind that message (sent as a photo on 12.11).
    tg.photos.push({ message_id: photo.messageId, chat_id: BORIS, photo: Buffer.from('old') })
    await bot.notifier.closeLeadCard(photo.messageId, { ...CARD, closedByBoris: true })
    expect(tg.mediaEdits).toHaveLength(1)
    expect(await stateOf(photo.messageId)).toMatchObject({ s: 'skipped' })
    const text = await bot.notifier.sendLeadCard({ ...CARD, taskId: otherTask })
    await db.insert(telegramCard).values({
      ref: text.messageId,
      taskId: otherTask,
      card: CARD,
      state: { s: 'new' },
      kind: 'text',
    })
    await bot.notifier.closeLeadCard(text.messageId, { ...CARD, closedByBoris: true })
    expect(tg.mediaEdits).toHaveLength(1)
    expect(tg.edited.at(-1)).toMatchObject({
      message_id: text.messageId,
      text: closedLeadCardText({ ...CARD, closedByBoris: true }),
    })
  })

  it('FR-NOTIF-6: a text card stays a text card: its edits are text edits even with the header on', async () => {
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
