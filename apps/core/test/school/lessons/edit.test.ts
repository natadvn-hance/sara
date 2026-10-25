import { describe, expect, it } from 'vitest'
import { similarity } from '../../../src/conversation/compare'
import { editWeight, numbersIn } from '../../../src/school/lessons/edit'

const w = (a: string, b: string, names: string[] = []) =>
  editWeight(a, b, { substantialBelow: 70, names })

describe('the weight of an edit', () => {
  it('FR-AUTO-4: a changed price is substantial even with similar words', () => {
    expect(
      w(
        'Сайт будет стоить 50 000 рублей, начнём через неделю',
        'Сайт будет стоить 80 000 рублей, начнём через неделю',
      ),
    ).toBe('substantial')
    expect(w('Сделаем за две недели', 'Сделаем за три недели')).toBe('substantial')
  })

  it('FR-AUTO-4: a small change is minor', () => {
    expect(
      w(
        'Давайте созвонимся завтра, обсудим задачу подробнее и посмотрим, что можно сделать',
        'Давайте созвонимся завтра, обсудим задачу подробнее и посмотрим, что можно успеть',
      ),
    ).toBe('minor')
  })

  it('FR-AUTO-4: an added greeting with the name keeps a short reply same', () => {
    expect(
      w('Сроки скажу после созвона', 'Анна, добрый день! Сроки скажу после созвона', ['Анна']),
    ).toBe('same')
    expect(w('Сроки скажу после созвона', 'Здравствуйте! Сроки скажу после созвона')).toBe('same')
  })

  it('FR-AUTO-4: a fixed typo is minor', () => {
    expect(w('Срки скажу после созвона', 'Сроки скажу после созвона')).toBe('minor')
  })

  it('FR-TRAIN-6: the same text is an approval, another text a substantial edit', () => {
    expect(w('Сроки скажу после созвона', 'сроки скажу после созвона.')).toBe('same')
    expect(w('Сроки скажу после созвона', 'Пришлите, пожалуйста, ТЗ, посмотрю вечером')).toBe(
      'substantial',
    )
  })

  it('FR-AUTO-4: numbers in digits and words are found', () => {
    expect(numbersIn('Бюджет 50 000, срок полтора месяца, две встречи')).toEqual([
      '1.5',
      '2',
      '50000',
    ])
    expect(numbersIn('без чисел')).toEqual([])
  })

  it('FR-AUTO-4: similarity is 100 for the same words and 0 for unrelated ones', () => {
    expect(similarity('Добрый день', 'добрый день!')).toBe(100)
    expect(similarity('абв', 'где')).toBe(0)
    expect(similarity('', '')).toBe(100)
  })

  it('FR-AUTO-4: two different short answers are not the same', () => {
    expect(similarity('Да', 'Не')).toBe(0)
    expect(similarity('Да', 'да!')).toBe(100)
    expect(w('Да', 'Нет')).toBe('substantial')
  })
})
