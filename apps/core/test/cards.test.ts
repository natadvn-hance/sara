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

describe('cards', () => {
  it('FR-NOTIF-1: lead card text, buttons and callback format', () => {
    expect(leadCardText(card)).toBe(
      '🔔 Заявка · Сайт для клиники, Краснодар\nПодходит: Нужен сайт\nОтклик 210 ₽',
    )
    expect(leadCardKeyboard(card).inline_keyboard[0]?.[0]).toEqual({
      text: 'Откликнуться за 210 ₽',
      callback_data: `t:${card.taskId}:bid`,
    })
    expect(leadCardKeyboard(card).inline_keyboard[0]?.[1]).toEqual({
      text: 'Пропустить',
      callback_data: `t:${card.taskId}:skip`,
    })
  })

  it('FR-LEAD-7: the card shows the score, the rules version and the reason', () => {
    const text = leadCardText({
      ...card,
      bidPriceRub: 148,
      score: { value: 68, version: 1, reason: 'Зрелый бизнес, понятная задача' },
    })
    expect(text).toBe(
      '🔔 Заявка · Сайт для клиники, Краснодар\nБалл 68 (правила v1). Зрелый бизнес, понятная задача\nОтклик 148\u00a0₽',
    )
    expect(text).not.toContain('Подходит:')
  })

  it('FR-LEAD-7: a card without a score says so', () => {
    expect(leadCardText({ ...card, score: null, unscored: true }).split('\n')).toEqual([
      '🔔 Заявка · Сайт для клиники, Краснодар',
      'Подходит: Нужен сайт',
      'Без оценки: Оценщик не ответил',
      'Отклик 210\u00a0₽',
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

  it('NFR-UX-1: no card text contains a long dash', () => {
    const texts = [
      leadCardText(card),
      leadCardText({ ...card, verdict: 'maybe' }),
      TEXTS.bound,
      TEXTS.alreadyDone,
      TEXTS.bidSent('Сайт', 210),
      TEXTS.reminder('Сайт'),
      TEXTS.bidsPaused,
      TEXTS.skipped,
      TEXTS.bidQueued,
    ]
    for (const t of texts) expect(t).not.toContain(DASH)
  })
})
