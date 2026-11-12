import { describe, expect, it } from 'vitest'
import { closedCardState, foldedCardState, newState } from '../../src/notify/cardState'
import type { LeadCard } from '../../src/notify/cards'
import { PICTURE_WIDTH, pictureKeyboard, renderCardPicture } from '../../src/notify/picture'

// FR-NOTIF-6, docs/superpowers/specs/2026-11-11-lead-card-widget.md: a large picture of the main, the long texts as text.

const taskId = '0192f3c4-5b6a-7c8d-9e0f-112233445566'
const DASH = String.fromCharCode(0x2014)
const NOW = new Date('2026-11-11T11:05:00.000Z')
/** Rubles are written with no-break spaces; the tests read them as plain ones. */
const sp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ')
const words = 'Очень длинный текст заявки про продвижение кофейни. '

const CARD: LeadCard = {
  taskId,
  orderId: '90001',
  title: 'Стратегия продвижения для кофейни',
  city: 'Дистанционно · Москва',
  budgetText: 'до 30 000 ₽',
  clientName: 'Ирина',
  text: 'Нужна стратегия продвижения для новой кофейни у метро. Есть соцсети, но заявок мало.',
  clientInfo: {
    name: 'Ирина',
    on_profi_since: '7 сентября 2020',
    phone_verified: true,
    reviews: { positive: 3, negative: 1 },
    review_tags: [],
    summaries: [{ description: 'Отвечает в течение часа', color_theme: 'green', percent: null }],
  },
  verdict: 'fit',
  reason: 'Стратегия',
  bidPriceRub: 55,
  score: {
    value: 72,
    version: 10,
    reason: 'Подходит: стратегия, а не ведение соцсетей. Минусы: бюджет небольшой.',
  },
  draft: {
    text: 'Добрый день, Ирина! Если я правильно понял, то нужна стратегия, а не просто посты.',
    priceRub: 15000,
    priceToRub: 25000,
    followUps: ['Могу показать похожий кейс кофейни.'],
  },
  analysis: {
    hiddenNeed: 'Поток гостей в будни',
    risk: 'Ждёт быстрых продаж от соцсетей',
    condition: 'Брать, если готова к плану на три месяца',
    reading: null,
  },
  similar: { n: 10, closed: 2, bid: 8, pct: 80, min: 10, enough: true, reason: null },
}

describe('the header picture of a lead card', () => {
  it('FR-NOTIF-6: a new card has a wide 3:2 header (Boris, 12.11.2026: «не выше 3:2»)', async () => {
    const { png, width, height } = await renderCardPicture(CARD, newState(CARD), NOW)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(width).toBe(PICTURE_WIDTH)
    expect(height).toBe((width * 2) / 3)
  })

  it('FR-NOTIF-6: the header has nothing of the text card: not the order, the reasons or the bid', async () => {
    const other: LeadCard = {
      ...CARD,
      text: 'Совсем другой текст заявки.',
      score: { value: 72, version: 10, reason: 'Подходит: другое. Минусы: другие.' },
      analysis: null,
      draft: null,
    }
    const a = await renderCardPicture(CARD, newState(CARD), NOW)
    const b = await renderCardPicture(other, newState(CARD), NOW)
    expect(a.png.equals(b.png)).toBe(true)
  })

  it('FR-NOTIF-6: the longest title keeps the header 3:2: its words are cut and get smaller, the header is not stretched', async () => {
    const long: LeadCard = {
      ...CARD,
      title: 'Очень длинный заголовок заявки про маркетинг, '.repeat(6),
      score: {
        value: 72,
        version: 10,
        reason: `Подходит: ${words.repeat(4)} Минусы: ${words.repeat(4)}`,
      },
      analysis: { ...(CARD.analysis as NonNullable<LeadCard['analysis']>), risk: words.repeat(4) },
      text: words.repeat(60),
    }
    const { width, height } = await renderCardPicture(long, newState(long), NOW)
    expect(height).toBe((width * 2) / 3)
  })

  it('FR-NOTIF-6: a card without score, analysis, client info, budget or text still draws', async () => {
    const bare: LeadCard = {
      ...CARD,
      score: null,
      analysis: null,
      clientInfo: null,
      similar: null,
      budgetText: null,
      bidPriceRub: 0,
      text: '',
    }
    expect((await renderCardPicture(bare, newState(bare), NOW)).width).toBe(PICTURE_WIDTH)
  })

  it('FR-NOTIF-6: every state draws its own picture, a later one is a short card', async () => {
    const states = [
      newState(CARD),
      foldedCardState({ state: 'sending' }),
      foldedCardState({ state: 'sent', at: '2026-11-11T11:17:00.000Z', feeRub: 54 }),
      closedCardState({ ...CARD, closedByBoris: true }, NOW),
    ]
    const pictures = await Promise.all(states.map((st) => renderCardPicture(CARD, st, NOW)))
    expect(new Set(pictures.map((p) => p.png.toString('base64'))).size).toBe(states.length)
    for (const p of pictures.slice(1)) expect(p.height).toBeLessThan(pictures[0]?.height ?? 0)
  })

  it('NFR-UX-1: a long dash from the order or the model still draws the header', async () => {
    const dashed = { ...CARD, title: `Сайт ${DASH} лендинг` }
    expect((await renderCardPicture(dashed, newState(dashed), NOW)).width).toBe(PICTURE_WIDTH)
  })

  it('FR-NOTIF-6: a new card has the bid with its fee as the main button, then «Правка», «Разбор», «Пропустить», each short', () => {
    const kb = pictureKeyboard(CARD, newState(CARD))
    expect(kb.map((r) => r.map((b) => sp(b.text)))).toEqual([
      ['Отправить отклик · 55 ₽'],
      ['Правка', 'Разбор', 'Пропустить'],
    ])
    expect(kb[0]?.[0]).toMatchObject({ callback_data: `t:${taskId}:bid`, style: 'danger' })
    // On a phone the main button holds about 26 characters, each of the three about 11.
    expect(kb[0]?.[0]?.text.length).toBeLessThanOrEqual(26)
    for (const b of kb[1] ?? []) expect(b.text.length).toBeLessThanOrEqual(11)
  })

  it('FR-NOTIF-6: a short card keeps only links, and the reasons under a skipped one', () => {
    const sent = foldedCardState({
      state: 'sent',
      at: NOW.toISOString(),
      chatUrl: 'https://t.me/c/1/2',
    })
    expect(pictureKeyboard(CARD, sent)).toEqual([
      [
        { text: 'Чат с клиентом', url: 'https://t.me/c/1/2' },
        { text: 'Открыть на Профи', url: 'https://profi.ru/backoffice/n.php?o=90001' },
      ],
    ])
    const reasons = [[{ text: 'Не мой профиль', callbackData: `r:${taskId}:1` }]]
    expect(
      pictureKeyboard(CARD, closedCardState({ ...CARD, closedByBoris: true }, NOW), reasons),
    ).toEqual([
      [{ text: 'Не мой профиль', callback_data: `r:${taskId}:1` }],
      [{ text: 'Открыть на Профи', url: 'https://profi.ru/backoffice/n.php?o=90001' }],
    ])
  })
})
