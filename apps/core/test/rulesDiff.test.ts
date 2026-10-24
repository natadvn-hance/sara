import { describe, expect, it } from 'vitest'
import { rulesDiff } from '../src/direction/diff'
import { RULES_V1 } from '../src/direction/v1'

describe('rules diff', () => {
  it('FR-MIND-3: a threshold change is one section, said in numbers', () => {
    expect(rulesDiff(RULES_V1, { ...RULES_V1, threshold: 60 })).toEqual({
      sections: ['threshold'],
      lines: ['Порог: 56 → 60'],
    })
  })

  it('FR-MIND-3: weights and the way an axis is scored are the axes section', () => {
    const axes = RULES_V1.axes.map((a) =>
      a.id === 'client'
        ? { ...a, weight: 25 }
        : a.id === 'budget'
          ? { ...a, weight: 25, how: 'Новое' }
          : a,
    )
    expect(rulesDiff(RULES_V1, { ...RULES_V1, axes })).toEqual({
      sections: ['axes'],
      lines: [
        'Вес «Качество клиента»: 30 → 25',
        'Вес «Бюджетная зрелость»: 20 → 25',
        'Как оценивать «Бюджетная зрелость»: Новое',
      ],
    })
  })

  it('FR-MIND-3: stop factors added, removed or edited are listed', () => {
    const stop = [
      ...RULES_V1.stop_factors.filter((s) => s.id !== 'percent'),
      { id: 'tender', text: 'Тендер с откатом', exception: null, examples: [] },
    ]
    const d = rulesDiff(RULES_V1, { ...RULES_V1, stop_factors: stop })
    expect(d.sections).toEqual(['stop_factors'])
    expect(d.lines).toEqual([
      'Новый стоп-фактор: Тендер с откатом',
      'Убран стоп-фактор: Работа за процент от продаж без фиксированной оплаты.',
    ])
  })

  it('FR-MIND-3: identical rules change nothing', () => {
    expect(rulesDiff(RULES_V1, structuredClone(RULES_V1))).toEqual({ sections: [], lines: [] })
  })
})
