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

  it('FR-LEAD-2: card without a sorter verdict asks Boris to check', () => {
    expect(leadCardText({ ...card, verdict: null, reason: null })).toContain(
      'Сортировщик не ответил, проверь сам',
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
