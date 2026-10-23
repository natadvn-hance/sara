import { describe, expect, it } from 'vitest'
import { anonymize, findLeaks } from '../profi-samples'

const raw = {
  kind: 'response' as const,
  url: 'https://profi.ru/api/orders/95147898?chat=777001',
  receivedAt: '2026-10-25T10:00:00.000Z',
  body: {
    order: {
      id: '95147898',
      subject: 'Сайт для клиники',
      description: 'Нужен сайт, звоните Ирине по +7 (918) 123-45-67 или пишите irina@mail.ru',
      client: { name: 'Ирина Петрова', profileUrl: 'https://profi.ru/profile/PetrovaIA/' },
      price: 210,
    },
    chats: [
      {
        chatId: '777001',
        orderId: '95147898',
        lastMessage: { text: 'Добрый день, Ирина!', author: 'client' },
      },
    ],
  },
}

describe('calibration samples', () => {
  it('ADR-022: a sample keeps no phone, name or message text of a client', () => {
    const out = JSON.stringify(anonymize(raw))
    for (const secret of [
      '123-45-67',
      '918',
      'irina@mail.ru',
      'Ирина',
      'Петрова',
      'PetrovaIA',
      'звоните',
      'Добрый день, Ирина',
    ]) {
      expect(out).not.toContain(secret)
    }
    expect(findLeaks(raw, anonymize(raw))).toEqual([])
  })

  it('ST-M1-10: the same order number is replaced the same way everywhere in a sample', () => {
    const a = anonymize(raw)
    const body = a.body as { order: { id: string }; chats: { chatId: string; orderId: string }[] }
    expect(body.order.id).not.toBe('95147898')
    expect(body.chats[0]?.orderId).toBe(body.order.id)
    expect(a.url).toContain(body.order.id)
    expect(a.url).toContain(body.chats[0]?.chatId)
  })

  it('ST-M1-10: the shape stays: keys, numbers that are not ids, lengths of texts', () => {
    const a = anonymize(raw).body as typeof raw.body
    expect(Object.keys(a.order).sort()).toEqual(Object.keys(raw.body.order).sort())
    expect(a.order.price).toBe(210)
    expect(a.order.description.length).toBe(raw.body.order.description.length)
    expect(a.chats[0]?.lastMessage.author).toBe('client')
  })

  it('ADR-022: an HTML page keeps its tags but no Russian words or phones', () => {
    const html = {
      kind: 'dom' as const,
      url: null,
      receivedAt: '2026-10-25T10:00:00.000Z',
      body: '<div class="cw_cO7-r-" data-message-content-id="m1">Позвоните мне, Олег, 8 900 111 22 33</div>',
    }
    const out = String(anonymize(html).body)
    expect(out).toContain('class="cw_cO7-r-"')
    expect(out).not.toMatch(/[а-яё]{2,}/i)
    expect(out).not.toContain('111 22 33')
  })

  it('ADR-022: a leak left in an output is found before it is written', () => {
    expect(findLeaks(raw, raw).length).toBeGreaterThan(0)
  })
})
