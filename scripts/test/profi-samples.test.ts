import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { anonymize, findLeaks, writeSamples } from '../profi-samples'

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

  // Shapes recorded on the live site 24.10.2026; the values here are made up.
  const frame = (o: object) => `a${JSON.stringify([JSON.stringify(o)])}`

  it('ADR-022: the JSON inside a stream frame is anonymized like the rest, numbers kept in step', () => {
    const r = {
      kind: 'rtp' as const,
      url: 'wss://online.profi.ru/socket.io/202/cw4mr2gg/websocket',
      receivedAt: '2026-10-24T09:11:35.787Z',
      body: frame({
        type: 'MSG_CHAT_ORDER_NOTIFY',
        containerId: 613600001,
        userId: 798700001,
        orderId: 94900001,
        messengerId: 101700001,
        messengerType: 'ORDER',
        messengerExtId: 94900001,
      }),
    }
    const out = anonymize(r)
    const body = String(out.body)
    for (const n of ['613600001', '798700001', '94900001', '101700001'])
      expect(body).not.toContain(n)
    const inner = JSON.parse(JSON.parse(body.slice(1))[0]) as Record<string, unknown>
    expect(inner.type).toBe('MSG_CHAT_ORDER_NOTIFY')
    expect(inner.messengerExtId).toBe(inner.orderId)
    expect(typeof inner.orderId).toBe('number')
    expect(findLeaks(r, out)).toEqual([])
    expect(findLeaks(r, r)).not.toEqual([])
  })

  it('ADR-022: a profile id is hidden everywhere, in links and stream frames too', () => {
    const r = {
      kind: 'response' as const,
      url: 'https://profi.ru/backoffice/api/',
      receivedAt: '2026-10-24T14:04:55.672Z',
      body: {
        data: {
          id: 'IvanovPP7',
          pid: 6800001,
          name: 'Иванов Пётр Петрович',
          link: 'https://profi.ru/media/landing/spec_referal_backoffice?p_id=IvanovPP7',
          stream: frame({ userId: 'IvanovPP7', type: 'SERVER_READY' }),
        },
        meta: { method: 'getProfile', prepId: 'IvanovPP7' },
      },
    }
    const out = anonymize(r)
    const text = JSON.stringify(out)
    for (const secret of ['IvanovPP7', '6800001', 'Иванов', 'Пётр'])
      expect(text).not.toContain(secret)
    expect((out.body as typeof r.body).meta.method).toBe('getProfile')
    expect(findLeaks(r, out)).toEqual([])
    expect(findLeaks(r, r)).toContain('IvanovPP7')
  })

  it('ADR-022: exact places are blurred: addresses replaced, coordinates rounded', () => {
    const r = {
      kind: 'response' as const,
      url: 'https://profi.ru/graphql',
      receivedAt: '2026-10-24T10:16:36.486Z',
      body: {
        address: { lat: 45.070377, lon: 39.028394, addr: 'Краснодар, Садовая улица, 82' },
        coords: { latitude: 45.03547, longitude: 38.975313 },
        coordinates: { lat: 55.6527, lon: 37.543 },
      },
    }
    const out = JSON.parse(JSON.stringify(anonymize(r).body))
    expect(out.address.lat).toBe(45)
    expect(out.address.lon).toBe(39)
    expect(out.coords).toEqual({ latitude: 45, longitude: 39 })
    expect(out.coordinates).toEqual({ lat: 56, lon: 38 })
    expect(out.address.addr).not.toMatch(/Садовая|82/)
    expect(out.address.addr.length).toBe(r.body.address.addr.length)
  })

  it('ADR-022: links to the files and photos of people lose their file names', () => {
    const r = {
      kind: 'response' as const,
      url: 'https://profi.ru/graphql',
      receivedAt: '2026-10-24T10:35:24.659Z',
      body: {
        images: [
          { host: 'cdn.profi.ru', original: '/xfiles/ofiles/95300001/cc8eef3881864767abcd.jpg' },
        ],
        avatar: 'https://cdn.profi.ru/xfiles/pfiles/1adfc98843d94057abcdef.jpg-profi_a34',
      },
    }
    const out = JSON.stringify(anonymize(r))
    expect(out).not.toContain('cc8eef3881864767abcd')
    expect(out).not.toContain('1adfc98843d94057abcdef')
    expect(out).toContain('/xfiles/ofiles/')
  })

  it('ADR-022: tokens and profile ids in link parameters are hidden', () => {
    const r = {
      kind: 'response' as const,
      url: 'https://profi.ru/backoffice/api/',
      receivedAt: '2026-10-24T14:04:55.672Z',
      body: {
        refundLink:
          'https://profi.ru/backoffice/bill.php?boFormType=MONEY_REFUND&bo_tkn=5S1lQqEJWkwqTBO615XBM7',
        invite: 'https://profi.ru/registration?_prr=IvanovPP7&utm_source=share',
      },
    }
    const out = anonymize(r)
    const body = out.body as typeof r.body
    expect(body.refundLink).not.toContain('5S1lQqEJWkwqTBO615XBM7')
    expect(body.refundLink).toContain('boFormType=MONEY_REFUND&bo_tkn=')
    expect(body.invite).not.toContain('IvanovPP7')
    expect(body.invite).toContain('utm_source=share')
    expect(findLeaks(r, out)).toEqual([])
    expect(findLeaks(r, r)).toEqual(expect.arrayContaining(['5S1lQqEJWkwqTBO615XBM7', 'IvanovPP7']))
  })

  it('ST-M1-10: what is not personal keeps its value: short link flags, colors, units', () => {
    const r = {
      kind: 'response' as const,
      url: 'wss://online.profi.ru/socket.io/869/qmd3dr1x/websocket?new_auth=1&appId=BO',
      receivedAt: '2026-10-24T10:16:36.486Z',
      body: {
        tags: [{ text: 'до 4000 ₽', textColor: 'G500', type: 'PRICE' }],
        amount: { label: 'Стоимость услуги', edizms: [{ id: '1', name: 'усл.' }] },
      },
    }
    const out = anonymize(r)
    expect(out.url).toBe(r.url)
    const body = out.body as typeof r.body
    expect(body.tags[0]?.textColor).toBe('G500')
    expect(body.amount.label).toBe('Стоимость услуги')
    expect(findLeaks(r, out)).toEqual([])
  })

  it('ADR-022: a client name written in Latin letters is replaced too, a field name is not', () => {
    const r = {
      kind: 'response' as const,
      url: 'https://profi.ru/graphql',
      receivedAt: '2026-10-24T10:35:24.659Z',
      body: {
        items: [
          { clientInfo: { name: 'Denis' } },
          { clientInfo: { name: 'Anna Smith' } },
          { clientInfo: { name: 'PalKom' } },
        ],
        amount: { name: 'stavka' },
      },
    }
    const out = anonymize(r)
    const text = JSON.stringify(out)
    expect(text).not.toContain('Denis')
    expect(text).not.toContain('Smith')
    expect(text).not.toContain('PalKom')
    expect((out.body as typeof r.body).amount.name).toBe('stavka')
    expect(findLeaks(r, out)).toEqual([])
    expect(findLeaks(r, r)).toContain('Denis')
  })

  it('ADR-022: an opaque blob, like the price hash of the bid form, is not kept', () => {
    const blob = `djg5VUxaVTlZR2NkcEh1aXd0MHptQU9leVgyNHFuWmlaYTdtYldDaHN2RnJsZloxakhYWnFL${'A'.repeat(40)}=`
    const r = {
      kind: 'response' as const,
      url: 'https://profi.ru/graphql',
      receivedAt: '2026-10-24T10:16:36.486Z',
      body: {
        priceHash: { name: 'price_hsh', type: 'HIDDEN', value: blob },
        bidSlide: { priceHash: blob },
      },
    }
    const out = JSON.stringify(anonymize(r))
    expect(out).not.toContain(blob.slice(0, 20))
    expect(out).toContain('price_hsh')
  })

  it('ST-M1-10: site texts keep no long dash, which the repository check forbids', () => {
    const dash = String.fromCharCode(0x2014)
    const r = {
      kind: 'response' as const,
      url: 'https://profi.ru/backoffice/api/',
      receivedAt: '2026-10-24T14:04:55.516Z',
      body: { inputCaption: `Сумма пополнения ${dash} от 1 до 20000 ₽` },
    }
    expect(JSON.stringify(anonymize(r))).not.toContain(dash)
  })

  it('ST-M1-10: records exported from the server become named sample files by kind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'samples-'))
    const res = await writeSamples([{ ...raw, name: 'order-page' }], root)
    expect(res).toEqual({ written: ['response/order-page.json'], refused: [] })
    const saved = JSON.parse(await readFile(join(root, 'response', 'order-page.json'), 'utf8'))
    expect(saved).toEqual(anonymize(raw))
  })
})
