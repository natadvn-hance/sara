import { describe, expect, it } from 'vitest'
import { type LeadCard, leadCardKeyboard, leadCardText, TEXTS } from '../src/notify/cards'

const card: LeadCard = {
  taskId: '0192f3c4-5b6a-7c8d-9e0f-112233445566',
  title: 'Сайт для клиники',
  city: 'Краснодар',
  verdict: 'fit',
  reason: 'Нужен сайт',
  bidPriceRub: 210,
}
const DASH = String.fromCharCode(0x2014)
const NBSP = ' '
const DRAFT = { text: 'Ирина, добрый день!\n\nПонимаю задачу.', priceRub: 90000 }

describe('cards', () => {
  it('FR-NOTIF-1: lead card text, buttons and callback format', () => {
    expect(
      leadCardText({ ...card, draft: DRAFT })
        .split('\n')
        .slice(0, 3),
    ).toEqual([
      '🔔 Заявка · Сайт для клиники, Краснодар',
      'Подходит: Нужен сайт',
      `Отклик 210${NBSP}₽`,
    ])
    expect(leadCardKeyboard(card).inline_keyboard[0]?.[0]).toEqual({
      text: `Откликнуться за 210${NBSP}₽`,
      callback_data: `t:${card.taskId}:bid`,
    })
  })

  it('FR-LEAD-7: the card shows the score, the rules version and the reason', () => {
    const text = leadCardText({
      ...card,
      bidPriceRub: 148,
      score: { value: 68, version: 1, reason: 'Зрелый бизнес, понятная задача' },
    })
    expect(text.split('\n').slice(0, 3)).toEqual([
      '🔔 Заявка · Сайт для клиники, Краснодар',
      'Балл 68 (правила v1). Зрелый бизнес, понятная задача',
      `Отклик 148${NBSP}₽`,
    ])
    expect(text).not.toContain('Подходит:')
  })

  it('FR-LEAD-7: the card shows the score, the draft and the service price', () => {
    const text = leadCardText({
      ...card,
      bidPriceRub: 148,
      score: { value: 68, version: 2, reason: 'Зрелый бизнес' },
      draft: DRAFT,
    })
    expect(text.split('\n')).toEqual([
      '🔔 Заявка · Сайт для клиники, Краснодар',
      'Балл 68 (правила v2). Зрелый бизнес',
      `Отклик 148${NBSP}₽`,
      '',
      'Черновик отклика:',
      'Ирина, добрый день!',
      '',
      'Понимаю задачу.',
      '',
      `Стоимость услуги: 90${NBSP}000${NBSP}₽`,
    ])
  })

  it('FR-LEAD-7: a draft without a price says the field stays empty', () => {
    const text = leadCardText({ ...card, draft: { ...DRAFT, priceRub: null } })
    expect(text.split('\n').at(-1)).toBe('Стоимость услуги: не указана')
  })

  it('FR-LEAD-7: a card without a draft says how to add one', () => {
    for (const draft of [null, undefined]) {
      expect(
        leadCardText({ ...card, draft })
          .split('\n')
          .slice(-2),
      ).toEqual(['', 'Черновика нет: Аналитик не ответил. Нажми «Изменить» и пришли текст.'])
    }
  })

  it('FR-LEAD-7: the buttons are «Откликнуться за N ₽», «Изменить», «Пропустить»', () => {
    expect(leadCardKeyboard(card).inline_keyboard).toEqual([
      [{ text: `Откликнуться за 210${NBSP}₽`, callback_data: `t:${card.taskId}:bid` }],
      [
        { text: 'Изменить', callback_data: `t:${card.taskId}:edit` },
        { text: 'Пропустить', callback_data: `t:${card.taskId}:skip` },
      ],
    ])
  })

  it('FR-LEAD-7: a card without a score says so', () => {
    expect(
      leadCardText({ ...card, score: null, unscored: true })
        .split('\n')
        .slice(0, 4),
    ).toEqual([
      '🔔 Заявка · Сайт для клиники, Краснодар',
      'Подходит: Нужен сайт',
      'Без оценки: Оценщик не ответил',
      `Отклик 210${NBSP}₽`,
    ])
  })

  it('FR-LEAD-2: card without a sorter verdict asks Boris to check', () => {
    expect(leadCardText({ ...card, verdict: null, reason: null })).toContain(
      'Сортировщик не ответил, проверь сам',
    )
  })

  it('NFR-UX-1: the summary counts orders in the right Russian form', () => {
    expect(TEXTS.summaryHead(1)).toBe('Сегодня отсеяла 1 заявку. На грани:')
    expect(TEXTS.summaryHead(3)).toBe('Сегодня отсеяла 3 заявки. На грани:')
    expect(TEXTS.summaryHead(11)).toBe('Сегодня отсеяла 11 заявок. На грани:')
    expect(TEXTS.summaryNone(21)).toBe('Сегодня отсеяла 21 заявку, пограничных не было')
    expect(TEXTS.summaryNone(25)).toBe('Сегодня отсеяла 25 заявок, пограничных не было')
  })

  it('NFR-UX-1: the proposal counts decisions in the right Russian form', () => {
    const last = (b: { checked: number; changed: number }) =>
      TEXTS.proposal(1, 'с', 'п', ['Порог: 56 → 60'], { ...b, towardBoris: 1, against: 0 })
        .split('\n')
        .at(-1)
    expect(last({ checked: 21, changed: 1 })).toBe(
      'На последних 21 заявке это изменило бы 1 решение: 1 в твою сторону, 0 против.',
    )
    expect(last({ checked: 100, changed: 3 })).toBe(
      'На последних 100 заявках это изменило бы 3 решения: 1 в твою сторону, 0 против.',
    )
    expect(last({ checked: 100, changed: 12 })).toBe(
      'На последних 100 заявках это изменило бы 12 решений: 1 в твою сторону, 0 против.',
    )
  })

  it('NFR-UX-1: the edit texts are exact and count characters in the right form', () => {
    expect(TEXTS.askDraft('Сайт')).toBe(
      'Пришли новый текст отклика на «Сайт» ответом на это сообщение, текстом или голосом. Приветствие я добавлю сама.',
    )
    expect(TEXTS.noDraft).toBe('Сначала нажми «Изменить» и пришли текст отклика')
    expect(TEXTS.draftTooLong(621)).toBe(
      'С приветствием выходит 621 знак, а Профи.ру принимает до 500. Пришли текст короче.',
    )
    expect(TEXTS.draftTooLong(605)).toBe(
      'С приветствием выходит 605 знаков, а Профи.ру принимает до 500. Пришли текст короче.',
    )
  })

  it('NFR-UX-1: no card text contains a long dash', () => {
    const texts = [
      leadCardText(card),
      leadCardText({ ...card, verdict: 'maybe' }),
      leadCardText({ ...card, draft: DRAFT }),
      leadCardText({ ...card, draft: { ...DRAFT, priceRub: null } }),
      TEXTS.bound,
      TEXTS.alreadyDone,
      TEXTS.bidSent('Сайт', 210),
      TEXTS.reminder('Сайт'),
      TEXTS.bidsPaused,
      TEXTS.skipped,
      TEXTS.bidQueued,
      TEXTS.askDraft('Сайт'),
      TEXTS.waitingDraft,
      TEXTS.noDraft,
      TEXTS.draftTooLong(621),
      TEXTS.draftSaved,
      TEXTS.draftLate,
      TEXTS.wantCard,
    ]
    for (const t of texts) expect(t).not.toContain(DASH)
  })
})
