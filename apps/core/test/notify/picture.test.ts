import { describe, expect, it } from 'vitest'
import { closedCardState, foldedCardState, newState } from '../../src/notify/cardState'
import type { LeadCard } from '../../src/notify/cards'
import {
  PICTURE_WIDTH,
  parseViewCallback,
  pictureKeyboard,
  renderCardPicture,
  viewCallback,
} from '../../src/notify/picture'

// FR-NOTIF-6, docs/superpowers/specs/2026-11-11-lead-card-widget.md: the lead card as a picture in Hance's look.

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

/** The size a PNG says it is (its IHDR chunk). */
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) })

describe('the lead card as a picture', () => {
  it("FR-NOTIF-6: a new card is one PNG 1080 pixels wide, from the title down to the client's words", async () => {
    const { png, width, height } = await renderCardPicture(CARD, newState(CARD), NOW)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(pngSize(png)).toEqual({ width, height })
    expect(width).toBe(PICTURE_WIDTH)
    expect(height).toBeGreaterThan(width)
    expect(height).toBeLessThan(width * 2.3)
  })

  it('FR-NOTIF-6: the longest order, title and bid keep the card in shape, only their words cut', async () => {
    const long: LeadCard = {
      ...CARD,
      title: 'Очень длинный заголовок заявки про маркетинг, '.repeat(6),
      text: words.repeat(60),
      draft: {
        text: words.repeat(10).slice(0, 500),
        priceRub: 15000,
        followUps: [
          words.repeat(3),
          'Можем созвониться на полчаса: {слоты}',
          'Пишите в тг @bmnoian)',
        ],
      },
    }
    const card = await renderCardPicture(long, newState(long), NOW)
    const bid = await renderCardPicture(long, { ...newState(long), v: 'bid' }, NOW)
    expect(card.height).toBeLessThan(PICTURE_WIDTH * 2.4)
    expect(bid.height).toBeLessThan(PICTURE_WIDTH * 2.2)
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
    const { width } = await renderCardPicture(bare, newState(bare), NOW)
    expect(width).toBe(PICTURE_WIDTH)
  })

  it('FR-NOTIF-6: every state draws its own picture, a later one is a short card', async () => {
    const states = [
      newState(CARD),
      { ...newState(CARD), v: 'bid' as const },
      foldedCardState({ state: 'sending' }),
      foldedCardState({ state: 'sent', at: '2026-11-11T11:17:00.000Z', feeRub: 54 }),
      closedCardState({ ...CARD, closedByBoris: true }, NOW),
    ]
    const pictures = await Promise.all(states.map((st) => renderCardPicture(CARD, st, NOW)))
    expect(new Set(pictures.map((p) => p.png.toString('base64'))).size).toBe(states.length)
    const full = pictures[0]?.height ?? 0
    for (const p of pictures.slice(2)) expect(p.height).toBeLessThan(full * 0.5)
    // A later state has one look: the view is only for a new card.
    const sent = foldedCardState({ state: 'sent', at: NOW.toISOString() })
    const a = await renderCardPicture(CARD, sent, NOW)
    const b = await renderCardPicture(CARD, { ...sent, v: 'bid' }, NOW)
    expect(a.png.equals(b.png)).toBe(true)
  })

  it('NFR-UX-1: a long dash from the order or the model is drawn as a hyphen, not refused', async () => {
    const dashed = { ...CARD, title: `Сайт ${DASH} лендинг`, text: `Нужно ${DASH} быстро` }
    const p = await renderCardPicture(dashed, newState(dashed), NOW)
    expect(p.width).toBe(PICTURE_WIDTH)
  })

  it('FR-NOTIF-6: a new card has the bid with its fee as the main button, the other view, then «Правка», «Разбор», «Пропустить»', () => {
    const kb = pictureKeyboard(CARD, newState(CARD))
    expect(kb.map((r) => r.map((b) => sp(b.text)))).toEqual([
      ['Отправить отклик · 55 ₽'],
      ['Текст отклика'],
      ['Правка', 'Разбор', 'Пропустить'],
    ])
    expect(kb[0]?.[0]).toMatchObject({ callback_data: `t:${taskId}:bid`, style: 'primary' })
    expect(kb[1]?.[0]?.callback_data).toBe(`v:${taskId}:bid`)
    expect(kb[2]?.map((b) => b.callback_data)).toEqual([
      `t:${taskId}:edit`,
      `t:${taskId}:razbor`,
      `t:${taskId}:skip`,
    ])
    expect(pictureKeyboard(CARD, { ...newState(CARD), v: 'bid' })[1]?.map((b) => b.text)).toEqual([
      'Карточка',
    ])
    expect(parseViewCallback(viewCallback(taskId, 'bid'))).toEqual({ taskId, view: 'bid' })
    expect(parseViewCallback(`t:${taskId}:bid`)).toBeNull()
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
    expect(pictureKeyboard(CARD, foldedCardState({ state: 'sending' }))).toEqual([])
    const reasons = [[{ text: 'Не мой профиль', callbackData: `r:${taskId}:1` }]]
    expect(
      pictureKeyboard(CARD, closedCardState({ ...CARD, closedByBoris: true }, NOW), reasons),
    ).toEqual([
      [{ text: 'Не мой профиль', callback_data: `r:${taskId}:1` }],
      [{ text: 'Открыть на Профи', url: 'https://profi.ru/backoffice/n.php?o=90001' }],
    ])
  })

  it('FR-NOTIF-6: the states say what the text card says: when a closed order closed, why a card was skipped', () => {
    expect(
      closedCardState(
        {
          ...CARD,
          closed: {
            since: '2026-11-11T10:00:00.000Z',
            published: true,
            at: '2026-11-11T10:40:00.000Z',
            exact: true,
            openUntil: null,
          },
        },
        NOW,
      ),
    ).toMatchObject({ s: 'closed', t: '14:05', n: 'закрылась через 40 мин после публикации' })
    expect(
      closedCardState(
        {
          ...CARD,
          closedByBoris: true,
          closeReason: { text: 'это соцсети', by: 'guess', buttons: [] },
        },
        NOW,
      ),
    ).toMatchObject({ s: 'skipped', n: 'Похоже, это соцсети' })
    expect(
      closedCardState(
        { ...CARD, stale: { since: '2026-11-10T09:00:00.000Z', at: '2026-11-11T11:00:00.000Z' } },
        NOW,
      ),
    ).toMatchObject({ s: 'stale', n: 'ждала решения 1 день 2 ч' })
  })
})
