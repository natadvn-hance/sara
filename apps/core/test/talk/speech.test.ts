import { describe, expect, it } from 'vitest'
import { cardinal, speakableText } from '../../src/talk/speech'

const ONLY_SPEAKABLE = /^[А-Яа-яЁё\s.,!?:;\-()«»"'…+]*$/

describe('the voice app: what Sara says aloud', () => {
  it('FR-NOTIF-5: numbers become Russian words, a thousand without «одна»', () => {
    expect(cardinal(0)).toBe('ноль')
    expect(cardinal(7)).toBe('семь')
    expect(cardinal(21)).toBe('двадцать один')
    expect(cardinal(210)).toBe('двести десять')
    expect(cardinal(1250)).toBe('тысяча двести пятьдесят')
    expect(cardinal(2000)).toBe('две тысячи')
    expect(cardinal(21_000)).toBe('двадцать одна тысяча')
    expect(cardinal(45_310)).toBe('сорок пять тысяч триста десять')
    expect(cardinal(1_000_000)).toBe('миллион')
    expect(cardinal(3_200_000)).toBe('три миллиона двести тысяч')
  })

  it('FR-NOTIF-5: money, percents and times are read the way a person says them', () => {
    expect(speakableText('Отклик стоит 210 ₽.')).toBe('Отклик стоит двести десять рублей.')
    expect(speakableText('На балансе 1 251 ₽')).toBe(
      'На балансе тысяча двести пятьдесят один рубль.',
    )
    expect(speakableText('цена 1250 руб., скидка 22%')).toBe(
      'цена тысяча двести пятьдесят рублей, скидка двадцать два процента.',
    )
    expect(speakableText('Созвон в 15:30, потом в 09:05')).toBe(
      'Созвон в пятнадцать тридцать, потом в девять ноль пять.',
    )
    expect(speakableText('Встреча 07.11 и 1.12.2026')).toBe(
      'Встреча седьмого ноября и первого декабря.',
    )
  })

  it('FR-NOTIF-5: a decimal is a number, not a date', () => {
    expect(speakableText('Ждать 1.5 часа')).toBe('Ждать один и пять часа.')
    expect(speakableText('рост 2,5%')).not.toMatch(/мая|февраля/)
  })

  it('FR-NOTIF-5: an order number is read digit by digit, a link is left to the text', () => {
    expect(speakableText('Заказ №95147898: https://profi.ru/backoffice/n.php?o=95147898')).toBe(
      'Заказ номер девять пять один четыре семь восемь девять восемь. Ссылки в тексте.',
    )
  })

  it('FR-NOTIF-5: marks, lists and emoji are not read, Latin words are said in Cyrillic', () => {
    const said = speakableText(
      '**Очередь** 📥\n- две заявки от Hance\n- одна в Telegram\n## Итог\nвсё OK',
    )
    expect(said).toBe('Очередь. две заявки от Ханс. одна в Телеграм. Итог. всё окей.')
    expect(speakableText('Проверь SEO и CRM в Profi')).toMatch(ONLY_SPEAKABLE)
  })

  it('FR-NOTIF-5: a long answer is cut at a sentence and points to the text', () => {
    const long = Array.from({ length: 80 }, (_, i) => `Это предложение номер ${i + 1}.`).join(' ')
    const said = speakableText(long)
    expect(said.length).toBeLessThanOrEqual(960)
    expect(said.endsWith('Остальное в тексте.')).toBe(true)
    expect(said).toMatch(ONLY_SPEAKABLE)
  })

  it('FR-NOTIF-5: nothing speakable gives an empty line', () => {
    expect(speakableText('📥 https://sara.hance.pro')).toBe('Ссылки в тексте.')
    expect(speakableText('   ')).toBe('')
  })
})
