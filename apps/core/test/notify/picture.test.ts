import { describe, expect, it } from 'vitest'
import { htmlProblem } from '../../../../tests/fakes/telegramApi'
import { SLOTS_MARK } from '../../src/leads/callSlots'
import { telegramLineOf } from '../../src/leads/telegramLine'
import { closedCardState, foldedCardState, newState } from '../../src/notify/cardState'
import { type LeadCard, MESSAGE_LIMIT, telegramTextLength } from '../../src/notify/cards'
import { pictureText } from '../../src/notify/cardText'
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

describe('the lead card as a large picture and text', () => {
  it('FR-NOTIF-6: a new card is one 4:3 picture (the mock of 12.11.2026), so Telegram shows it large, at the full width of the message', async () => {
    const { png, width, height } = await renderCardPicture(CARD, newState(CARD), NOW)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(width).toBe(PICTURE_WIDTH)
    expect(height).toBe((width * 3) / 4)
  })

  it('FR-NOTIF-6: the longest title and reasons keep the picture as large: their words are cut, not the card stretched', async () => {
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
    expect(height).toBe((width * 3) / 4)
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

  it('NFR-UX-1: a long dash from the order or the model reaches neither the picture nor the text', async () => {
    const dashed = { ...CARD, title: `Сайт ${DASH} лендинг`, text: `Нужно ${DASH} быстро` }
    expect((await renderCardPicture(dashed, newState(dashed), NOW)).width).toBe(PICTURE_WIDTH)
    expect(pictureText(dashed, newState(dashed))).not.toMatch(/[\u2013\u2014]/)
  })

  it('FR-NOTIF-6: the wide card starts with the main: the title in bold, where and who, the figures in one line, the plus, the minus and the risk', () => {
    const html = pictureText(CARD, newState(CARD))
    expect(htmlProblem(html)).toBeNull()
    expect(sp(html).split('\n\n').slice(0, 3)).toEqual([
      '<b>Стратегия продвижения для кофейни</b>\nдистанционно · Москва · Ирина, на Профи с 2020',
      'Балл <b>72/100</b> · Бюджет <b>до 30 000 ₽</b> · Отклик <b>55 ₽</b>',
      '➕ Стратегия, а не ведение соцсетей\n➖ Бюджет небольшой\n⚠️ Ждёт быстрых продаж от соцсетей',
    ])
    const bare: LeadCard = {
      ...CARD,
      score: null,
      analysis: null,
      budgetText: null,
      bidPriceRub: 0,
    }
    expect(pictureText(bare, newState(bare))).toContain(
      '\n\nБез оценки · Бюджет <b>не указан</b>\n\n',
    )
  })

  it("FR-NOTIF-6: under the main, as on the mock: the client's whole words folded, «Отклик · от … до …» with the bid folded, the series, the link", () => {
    const html = pictureText(CARD, newState(CARD))
    expect(htmlProblem(html)).toBeNull()
    expect(html).toContain(`\n\n<blockquote expandable>${CARD.text}</blockquote>\n\n`)
    expect(sp(html)).toContain('<b>Отклик</b> · от 15 000 до 25 000 ₽')
    expect(html).toContain('<blockquote expandable>Добрый день, Ирина!')
    expect(html).toContain(
      '<b>Вдогонку:</b> сообщение\n<blockquote expandable>Могу показать похожий кейс кофейни.</blockquote>',
    )
    expect(html).toContain(
      '<a href="https://profi.ru/backoffice/n.php?o=90001">Открыть на Профи.ру</a>',
    )
  })

  it('FR-NOTIF-6: the call offer and the Telegram line are one line, as on the mock: «Вдогонку: созвон на 30 минут, телеграм»', () => {
    const card: LeadCard = {
      ...CARD,
      draft: {
        ...(CARD.draft as NonNullable<LeadCard['draft']>),
        followUps: [
          `Предлагаю созвониться на 30 минут и обсудить детали. Вам удобно ${SLOTS_MARK}?`,
          telegramLineOf('@hance_demo') ?? '',
        ],
      },
    }
    const html = pictureText(card, newState(card))
    expect(html).toContain('<b>Вдогонку:</b> созвон на 30 минут, телеграм\n\n<a href=')
    expect(html).not.toContain(SLOTS_MARK)
    expect(html).not.toContain('@hance_demo')
  })

  it("FR-NOTIF-6: the longest order still makes one message: the client's words give way, the bid stays whole", () => {
    const html = pictureText({ ...CARD, text: words.repeat(200) }, newState(CARD))
    expect(telegramTextLength(html)).toBeLessThanOrEqual(MESSAGE_LIMIT - 100)
    expect(htmlProblem(html)).toBeNull()
    expect(html).toContain(`${CARD.draft?.text}</blockquote>`)
    expect(html).toContain('…</blockquote>')
  })

  it('FR-NOTIF-6: words from the site or the model reach the text as text, never as markup', () => {
    const html = pictureText(
      {
        ...CARD,
        title: 'Сайт <script>',
        text: '</blockquote><a href="x">ссылка</a> & <b>',
        draft: { text: '<i>кофе</i>', priceRub: null },
      },
      newState(CARD),
    )
    expect(htmlProblem(html)).toBeNull()
    expect(html).toContain('&lt;/blockquote&gt;&lt;a href="x"&gt;ссылка&lt;/a&gt; &amp; &lt;b&gt;')
    expect(html).toContain('&lt;i&gt;кофе&lt;/i&gt;')
    expect(html).toContain('<b>Сайт &lt;script&gt;</b>')
  })

  it('FR-NOTIF-6: a later state is a short text card: the title, then what happened in one line', () => {
    const sent = foldedCardState({ state: 'sent', at: '2026-11-11T11:17:00.000Z', feeRub: 54 })
    expect(sp(pictureText(CARD, sent)).split('\n').slice(0, 2)).toEqual([
      '<b>Стратегия продвижения для кофейни</b>',
      'Отклик ушёл в 14:17, списано 54 ₽',
    ])
    expect(pictureText(CARD, foldedCardState({ state: 'sending' })).split('\n')[1]).toBe(
      'Отправляю отклик…',
    )
    expect(pictureText(CARD, { s: 'note', n: 'Карточка обновлена, новая ниже' })).toBe(
      '<b>Стратегия продвижения для кофейни</b>\nКарточка обновлена, новая ниже\n<a href="https://profi.ru/backoffice/n.php?o=90001">Открыть на Профи.ру</a>',
    )
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
