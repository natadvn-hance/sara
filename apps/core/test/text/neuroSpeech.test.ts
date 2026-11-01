import { describe, expect, it } from 'vitest'
import { neuroSpeech } from '../../src/text/neuroSpeech'

describe('FR-CONV-15: the «не X, а Y» turn is found', () => {
  it('finds the words of Boris and their kin', () => {
    for (const text of [
      'Вам нужен не подрядчик на разовые задачи, а человек, который берет это на себя.',
      'Задача не просто провести встречи, а понять, что у вас происходит.',
      'Главная беда не в качестве работы, а в том, что нет системы.',
      'Это не только сайт, но и воронка.',
      'Важна не цена, а результат.',
      'Нужно не звонить, а писать.',
    ])
      expect(neuroSpeech(text), text).not.toBeNull()
  })

  it('leaves plain talk alone', () => {
    for (const text of [
      'Давайте не во вторник, а в среду.',
      'Не в 10, а в 11 удобно?',
      'Не получится завтра, а в пятницу смогу.',
      'Я не против, а вы?',
      'Работаем без предоплаты, а оплата по этапам.',
      'Не знаю, а что вы хотели бы?',
    ])
      expect(neuroSpeech(text), text).toBeNull()
  })
})
