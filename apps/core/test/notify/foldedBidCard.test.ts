import { describe, expect, it } from 'vitest'
import { foldedBidCard } from '../../src/notify/cards'

const plain = (t: string) => t.replace(/<[^>]*>/g, '').replace(/[  ]/g, ' ')
const base = { title: 'Нужен сайт <для> клиники', clientName: 'Роберт', orderId: '95498816' }

describe('the card of a bid, folded', () => {
  it('FR-UI-1: sent: the state with time and fee, the order, the client with the range, two links in words', () => {
    const t = foldedBidCard({
      ...base,
      state: 'sent',
      at: '2026-11-03T15:51:00.000Z',
      feeRub: 604,
      priceFromRub: 60000,
      priceToRub: 90000,
      chatUrl: 'https://t.me/c/123/45',
    })
    expect(plain(t).split('\n')).toEqual([
      '✅ Отклик отправлен · 18:51 · 604 ₽',
      'Нужен сайт &lt;для&gt; клиники',
      'Роберт · услуга от 60 000 ₽ до 90 000 ₽',
      'Заказ на Профи.ру · Чат с клиентом',
    ])
    expect(t).toContain(
      '<a href="https://profi.ru/backoffice/n.php?o=95498816">Заказ на Профи.ру</a>',
    )
    expect(t).toContain('<a href="https://t.me/c/123/45">Чат с клиентом</a>')
    // The title is escaped as markup, not left to break it.
    expect(t).toContain('Нужен сайт &lt;для&gt; клиники')
    expect(t).not.toMatch(/[–—]/)
  })

  it('FR-UI-1: without a forum there is no chat link, without a fee no money, a free bid shows none', () => {
    const t = foldedBidCard({ ...base, state: 'sent', at: '2026-11-03T15:51:00.000Z', feeRub: 0 })
    expect(plain(t)).not.toContain('Чат с клиентом')
    expect(plain(t).split('\n')[0]).toBe('✅ Отклик отправлен · 18:51')
  })

  it('FR-UI-1: sending, found later and not known each have their own head', () => {
    expect(plain(foldedBidCard({ ...base, state: 'sending' })).split('\n')[0]).toBe(
      '⏳ Отправляю отклик',
    )
    expect(foldedBidCard({ ...base, state: 'sending' })).not.toContain('Заказ на Профи.ру')
    expect(plain(foldedBidCard({ ...base, state: 'found', feeRub: 210 })).split('\n')[0]).toBe(
      '✅ Отклик найден на Профи.ру · 210 ₽',
    )
    const unsure = plain(foldedBidCard({ ...base, state: 'unsure' }))
    expect(unsure.split('\n')[0]).toBe('⚠️ Не знаю, ушёл ли отклик')
    expect(unsure).toContain('Проверь заявку на Профи.ру, прежде чем откликаться вручную')
  })
})
