import { formatRub } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { shortReason, summaryText } from '../../src/learning/summaryText'

const counts = {
  seen: 288,
  sorted: 125,
  scored: 104,
  marketing: 6,
  sites: 5,
  other: 4,
  bids: 1,
  spentRub: 63,
}
const none = { stopped: 0, stoppedBy: '', marked: 0, markedBy: '' }
const now = new Date('2026-11-04T16:30:00Z')

describe('the evening report', () => {
  it('reads as the way from the board to the bids, then what nearly passed', () => {
    const text = summaryText({
      now,
      counts,
      screen: {
        stopped: 5,
        stoppedBy: 'новый аккаунт 5',
        marked: 33,
        markedBy: 'короткий текст 14, яндекс директ 16',
      },
      near: [
        {
          orderId: '95700001',
          title: 'Привлечение трафика в приложение\n',
          score: 49,
          threshold: 50,
          reason:
            'Клиент просит совет по продвижению. Есть потенциал для стратегии, но бюджет небольшой, а задача названа разовой.',
        },
      ],
      held: [],
      heldMore: 0,
    })
    expect(text.split('\n')).toEqual([
      '📊 <b>Итоги дня</b> · 4 ноября',
      '',
      'Заявок на доске: 288',
      'Не наш профиль: 125',
      'Балл или стоп-фактор: 104',
      'Отсеяно сразу: новый аккаунт 5',
      '<b>Карточек вам: 15</b> (маркетинг 6, сайты 5, остальное 4)',
      `Откликов: 1, потрачено ${formatRub(63)}`,
      '',
      '<b>Почти прошли, посмотрите:</b>',
      '1. <a href="https://profi.ru/backoffice/n.php?o=95700001">Привлечение трафика в приложение</a>, балл 49 при пороге 50',
      'Есть потенциал для стратегии, но бюджет небольшой, а задача названа разовой',
      '',
      '<blockquote expandable>Отсев отметил ещё 33 и пропустил дальше: короткий текст 14, яндекс директ 16</blockquote>',
    ])
  })

  it('leaves out what the day did not have', () => {
    const text = summaryText({
      now,
      counts: { ...counts, marketing: 0, sites: 0, other: 0, bids: 0, spentRub: 0 },
      screen: none,
      near: [],
      held: [],
      heldMore: 0,
    })
    expect(text).toContain('<b>Карточек вам: 0</b>\n')
    expect(text).toContain('Откликов: 0')
    expect(text).not.toContain('потрачено')
    expect(text).not.toContain('Почти прошли')
    expect(text).not.toContain('Отсеяно сразу')
    expect(text).not.toContain('blockquote')
  })

  it('escapes the words of an order', () => {
    const text = summaryText({
      now,
      counts,
      screen: none,
      near: [
        { orderId: '1', title: 'Сайт <b> & лендинг', score: 45, threshold: 50, reason: 'A & B' },
      ],
      held: [],
      heldMore: 0,
    })
    expect(text).toContain('Сайт &lt;b&gt; &amp; лендинг')
    expect(text).toContain('A &amp; B')
  })

  it('keeps the reason to its last sentence, without the screen’s minus', () => {
    expect(
      shortReason(
        'Заказ на лендинг, стоп-факторов нет. Бюджет скромный и стратегии нет, поэтому оценка около порога. (минус 5: мало слов клиента)',
      ),
    ).toBe('Бюджет скромный и стратегии нет, поэтому оценка около порога')
    const long = shortReason(`${'слово '.repeat(60)}конец.`)
    expect(long.length).toBeLessThanOrEqual(141)
    expect(long.endsWith('…')).toBe(true)
  })
})
