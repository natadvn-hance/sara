import { describe, expect, it } from 'vitest'
import { type LeadRow, pseudonymize } from '../src/stand/pseudonymize'

// Invented lead: the shape of core.lead, no real client.
const LEAD: LeadRow = {
  id: '95000001',
  title: 'Сайт для клиники Ирины',
  category: 'Создание сайтов',
  city: 'Краснодар',
  text: 'Меня зовут Ирина, телефон +7 916 123-45-67, сайт irina-clinic.ru. Пишите Ирине на ira@mail.ru или @irina_k. Бухгалтер Тамара в курсе.',
  client_name: 'Ирина',
  budget_text: 'до 150 000 ₽',
  bid_price_rub: 260,
  client_info: {
    name: 'Ирина',
    on_profi_since: 'На Профи.ру с 7 сентября 2020',
    phone_verified: true,
    reviews: { positive: 3, negative: 0 },
    review_tags: ['Вежливая'],
  },
}

describe('copies of real orders on the stand', () => {
  it('NFR-PRIV-2: the client name, phones, mails, links and handles are made up, the order stays readable', () => {
    const copy = pseudonymize(LEAD)
    const all = JSON.stringify(copy)
    for (const real of ['Ирин', '916', 'irina', 'ira@', 'mail.ru', '@irina_k']) {
      expect(all).not.toContain(real)
    }
    expect(copy.client_name).not.toBe('')
    // One made-up name for the client everywhere: the card, the page and the text agree.
    expect(copy.title).toContain(copy.client_name)
    expect(copy.text).toContain(`Меня зовут ${copy.client_name}`)
    expect(copy.client_info?.name).toBe(copy.client_name)
    expect(copy.text).toContain('+7 900 000-00-01')
    expect(copy.text).toContain('example.com/')
    expect(copy).toMatchObject({
      category: 'Создание сайтов',
      city: 'Краснодар',
      budget_text: 'до 150 000 ₽',
      bid_price_rub: 260,
    })
    expect(copy.client_info?.reviews).toEqual({ positive: 3, negative: 0 })
  })

  it('NFR-PRIV-2: the same lead gets the same made-up name every import, another lead may get another', () => {
    expect(pseudonymize(LEAD).client_name).toBe(pseudonymize(LEAD).client_name)
    const names = new Set(
      Array.from(
        { length: 12 },
        (_, i) => pseudonymize({ ...LEAD, id: `9500010${i}` }).client_name,
      ),
    )
    expect(names.size).toBeGreaterThan(1)
  })

  it('NFR-PRIV-2: a lead without a name and without the page stays without them', () => {
    const copy = pseudonymize({
      ...LEAD,
      client_name: '',
      client_info: null,
      text: 'Нужен лендинг.',
    })
    expect(copy).toMatchObject({ client_name: '', client_info: null, text: 'Нужен лендинг.' })
  })
})
