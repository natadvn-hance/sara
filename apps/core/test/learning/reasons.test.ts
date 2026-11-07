import { describe, expect, it } from 'vitest'
import {
  budgetMaxRub,
  codeOfAction,
  type GuessInput,
  guessReason,
  rankReasons,
  reasonButtons,
  reasonFromWords,
  reasonText,
} from '../../src/learning/reasons'

const card = (over: Partial<GuessInput> = {}): GuessInput => ({
  title: 'Маркетинговая стратегия для клиники',
  category: 'Маркетинговые стратегии',
  budgetText: 'до 100 000 ₽',
  feeRub: 300,
  score: 72,
  threshold: 40,
  stopFactor: null,
  redFlags: [],
  axes: [
    { id: 'client', score: 70 },
    { id: 'system', score: 75 },
    { id: 'budget', score: 70 },
    { id: 'competition', score: 70 },
    { id: 'ltv', score: 70 },
  ],
  clientLines: [],
  ...over,
})

describe('the guessed reason of a close (07.11.2026)', () => {
  it('a clean strategy order points to no reason', () => {
    expect(guessReason(card())).toBeNull()
  })

  it('SMM in the title or the category is «не наш профиль: SMM ведение»', () => {
    const r = guessReason(card({ title: 'Ведение Instagram для кофейни', category: 'SMM' }))
    expect(r).toEqual({ code: 'profile', detail: 'SMM ведение' })
    expect(reasonText(r ?? { code: 'other', detail: null })).toBe('не наш профиль: SMM ведение')
  })

  it('an SMM strategy in a marketing category is not taken for SMM work', () => {
    expect(guessReason(card({ title: 'SMM-стратегия для бренда одежды' }))).toBeNull()
  })

  it('a stop factor speaks loudest', () => {
    expect(
      guessReason(card({ title: 'Ведение Instagram', category: 'SMM', stopFactor: 'vacancy' })),
    ).toEqual({ code: 'profile', detail: 'вакансия в штат' })
    expect(guessReason(card({ stopFactor: 'percent' }))).toEqual({
      code: 'budget',
      detail: 'работа за процент',
    })
  })

  it('a site order is «сайт, а не маркетинг»; a marketplace or ads in «Остальное» are not our profile', () => {
    expect(guessReason(card({ title: 'Лендинг для школы', category: 'Создание сайтов' }))).toEqual({
      code: 'site',
      detail: null,
    })
    expect(
      guessReason(card({ title: 'Карточки товаров', category: 'Менеджер маркетплейсов' })),
    ).toEqual({ code: 'profile', detail: 'маркетплейс' })
    expect(
      guessReason(card({ title: 'Настроить Директ', category: 'Контекстная реклама' })),
    ).toEqual({ code: 'profile', detail: 'настройка рекламы' })
  })

  it('a small budget, a red flag, a client who rarely agrees', () => {
    expect(guessReason(card({ budgetText: 'до 10 000 ₽' }))).toEqual({
      code: 'budget',
      detail: 'до 10 000 ₽',
    })
    expect(guessReason(card({ redFlags: ['chaotic'] }))).toEqual({ code: 'vague', detail: null })
    expect(guessReason(card({ clientLines: ['Договаривается в 20% случаев'] }))).toEqual({
      code: 'client',
      detail: 'договаривается в 20%',
    })
    expect(guessReason(card({ clientLines: ['Договаривается в 70% случаев'] }))).toBeNull()
  })

  it('the weakest axis, a dear fee near the threshold, a score just over it', () => {
    expect(
      guessReason(
        card({
          axes: [
            { id: 'client', score: 70 },
            { id: 'competition', score: 30 },
          ],
        }),
      ),
    ).toEqual({ code: 'compete', detail: null })
    expect(guessReason(card({ score: 45, feeRub: 1200 }))).toEqual({
      code: 'fee',
      detail: '1 200 ₽',
    })
    expect(guessReason(card({ score: 42 }))).toEqual({ code: 'border', detail: null })
  })

  it('the buttons: three other likely reasons, then the usual ones, «Другое» last', () => {
    const ranked = rankReasons(
      card({ title: 'Ведение Instagram', category: 'SMM', budgetText: 'до 5 000 ₽' }),
    )
    expect(ranked.map((r) => r.code)).toEqual(['profile', 'budget'])
    expect(reasonButtons(ranked, 'profile')).toEqual(['budget', 'site', 'client', 'other'])
    expect(reasonButtons([], null)).toEqual(['profile', 'site', 'budget', 'other'])
  })

  it('a button press reads back as its code; anything else is none', () => {
    expect(codeOfAction('whybudget')).toBe('budget')
    expect(codeOfAction('whyborder')).toBeNull()
    expect(codeOfAction('skip')).toBeNull()
  })

  it("Boris's words with a close become a reason from the list, or «другое» as he said them", () => {
    expect(reasonFromWords('копейки')).toEqual({ code: 'budget', detail: null })
    expect(reasonFromWords('это ведение смм, не наше')).toEqual({
      code: 'profile',
      detail: 'SMM ведение',
    })
    expect(reasonFromWords('отклик дорогой для такого')).toEqual({ code: 'fee', detail: null })
    expect(reasonFromWords('уже работаем с ними')).toEqual({
      code: 'other',
      detail: 'уже работаем с ними',
    })
    expect(reasonText({ code: 'other', detail: 'уже работаем с ними' })).toBe('уже работаем с ними')
  })

  it('the budget line is read for its highest sum', () => {
    expect(budgetMaxRub('от 30 000 до 50 000 ₽')).toBe(50000)
    expect(budgetMaxRub('до 15 тыс. руб.')).toBe(15000)
    expect(budgetMaxRub('15к ₽')).toBe(15000)
    expect(budgetMaxRub('10 000 ₽ к оплате')).toBe(10000)
    expect(budgetMaxRub('Договорная')).toBeNull()
    expect(budgetMaxRub(null)).toBeNull()
  })
})
