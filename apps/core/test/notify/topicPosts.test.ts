import { describe, expect, it } from 'vitest'
import {
  bidPost,
  clientPost,
  introPost,
  ourPost,
  seriesPost,
  stamp,
  stepPost,
} from '../../src/notify/topicPosts'

describe('the posts of a client topic', () => {
  it('ST-M7-16: every post says who and when, with a real date, in Moscow time', () => {
    expect(stamp('2026-10-28T12:39:00.000Z', new Date('2026-11-01T10:00:00Z'))).toBe(
      '28 октября, 15:39',
    )
    expect(stamp('2025-06-01T09:00:00.000Z', new Date('2026-11-01T10:00:00Z'))).toBe(
      '1 июня 2025, 12:00',
    )
    expect(clientPost({ name: 'Роберт', at: '2026-10-28T13:02:00.000Z', text: 'Привет' })).toBe(
      '💬 <b>Роберт</b> · 28 октября, 16:02\n<blockquote>Привет</blockquote>',
    )
    expect(ourPost({ at: '2026-10-28T13:20:00.000Z', text: 'Добрый день' })).toContain(
      '<b>Вы</b> · 28 октября, 16:20',
    )
    expect(seriesPost({ at: '2026-10-31T14:12:00.000Z', text: 'Кейс', n: 1, total: 2 })).toContain(
      '<b>Вдогонку 1 из 2</b> · 31 октября, 17:12',
    )
    expect(stepPost('👁 Клиент прочитал отклик', '2026-10-28T12:45:00.000Z')).toBe(
      '<i>👁 Клиент прочитал отклик · 28 октября, 15:45</i>',
    )
  })

  it('ST-M7-16: the bid shows the fee only when there is one, and the range of the service', () => {
    const full = bidPost({
      at: '2026-10-28T12:39:00.000Z',
      text: 'Текст',
      feeRub: 290,
      priceFromRub: 60000,
      priceToRub: 90000,
    })
    const plain = full.replace(/\u00a0|\u202f/g, ' ')
    expect(plain).toContain('Отклик: 290 ₽')
    expect(plain).toContain('Услуга: от 60 000 ₽ до 90 000 ₽')
    const free = bidPost({
      at: '2026-10-28T12:39:00.000Z',
      text: 'Текст',
      feeRub: 0,
      priceFromRub: null,
      priceToRub: null,
    })
    expect(free).not.toContain('Отклик:')
    expect(free).not.toContain('Услуга')
  })

  it('NFR-UX-1: text from outside is escaped and has no long dash', () => {
    const p = clientPost({ name: 'А<b>', at: '2026-10-28T13:02:00.000Z', text: 'a — b <i> & c' })
    expect(p).toContain('А&lt;b&gt;')
    expect(p).toContain('a - b &lt;i&gt; &amp; c')
    expect(p).not.toMatch(/[–—]/)
  })

  it('ST-M7-16: the first post is laid out: title, who, facts as bullets, the full text folded, a link in words', () => {
    const intro = introPost({
      title: 'Нужен сайт',
      orderId: '95498816',
      clientName: 'Роберт',
      city: 'Краснодар',
      budget: 'до 80 000 ₽',
      seenAt: '2026-10-28T12:30:00.000Z',
      text: `Нужен сайт для клиники · Тип: многостраничный · Срок: месяц · ${'Подробности '.repeat(50)}`,
    })
    expect(intro).toContain('📌 <b>Нужен сайт</b>')
    expect(intro).toContain('Роберт · Краснодар · бюджет до 80 000 ₽')
    expect(intro).toContain('Заявка от 28 октября, 15:30')
    expect(intro).toContain('• Тип: многостраничный')
    expect(intro).toContain('<blockquote expandable>')
    expect(intro).toContain(
      '<a href="https://profi.ru/backoffice/n.php?o=95498816">Открыть заказ на Профи.ру</a>',
    )
    expect(intro).toContain('<i>Здесь всё по этому клиенту')
  })
})
