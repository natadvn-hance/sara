import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { authorFromClasses, orderFromPageText, profiParsers } from '../src/eyes/profiParsers'
import { nodeTestUrl } from './helpers/db'

let ab: AccountBrowser
beforeAll(async () => {
  ab = await openAccountBrowser({
    accountId: 'parsers-test',
    profileDir: await mkdtemp(join(tmpdir(), 'pp-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
}, 60000)
afterAll(() => ab.close())

// Shapes from old Sara (src/ingestion/feedPoller.js, src/watcher/messageDom.js), checked live in Sept-Oct 2026.
const FEED = `<nav><a href="/backoffice/n.php">Заказы</a><a href="/backoffice/chats.php">Чаты</a><span>23 ₽</span></nav>
<a href="/backoffice/n.php?o=95100001">Сайт для клиники\nНужен сайт с записью\nКраснодар\nИрина</a>
<a href="/backoffice/n.php?o=95100002">false\nТаргет для кофейни\nСочи</a>
<a href="/backoffice/n.php?o=95100001">дубль той же карточки</a>`

const ORDER_TEXT = [
  'Заказы',
  'Чаты',
  'Поддержка',
  'Создание сайтов',
  'до 150 000 ₽',
  'Описание',
  'Нужен сайт для клиники с онлайн-записью.',
  'Есть логотип.',
  'Дистанционно',
  'Краснодар',
  'Когда',
  'В ближайшее время',
  'Детали заказа',
  'И',
  'Ирина',
  'Тариф',
  'Отклик • 210 ₽',
].join('\n')

const CHAT = `
<div class="cw_msg cw_iCsdtF" data-message-content-id="m1"><div class="cw_xeDn2R"><div class="cw_BFgZYK">Добрый день! Готовы помочь.</div></div></div>
<div class="cw_msg cw_cO7-r-" data-message-content-id="m2"><div class="cw_xeDn2R"><div class="cw_BFgZYK">Сколько стоит?</div></div></div>
<div class="cw_msg cw_GK6qZJ" data-message-content-id="m3"><div class="cw_xeDn2R"><div class="cw_BFgZYK">Вы обменялись контактами</div></div></div>
<div class="cw_msg cw_ZZZ999" data-message-content-id="m4"><div class="cw_xeDn2R"><div class="cw_BFgZYK">кто это</div></div></div>`

describe('Profi.ru page readers', () => {
  it('ST-M1-06: the feed page gives each order number once with its card text', async () => {
    await ab.page.setContent(FEED)
    const r = await profiParsers.fromFeedDom?.(ab.page)
    expect(r?.recognized).toBe(true)
    expect(r?.refs.map((x) => x.orderId)).toEqual(['95100001', '95100002'])
  })

  it('ST-M1-06: an order page gives title, budget, text, city, client and bid price', () => {
    expect(orderFromPageText(ORDER_TEXT, '95100001')).toMatchObject({
      order_id: '95100001',
      title: 'Создание сайтов',
      category: 'Создание сайтов',
      budget_text: 'до 150 000 ₽',
      text: 'Нужен сайт для клиники с онлайн-записью.\nЕсть логотип.',
      city: 'Краснодар',
      client_name: 'Ирина',
      bid_price_rub: 210,
    })
  })

  it('ST-M1-06: a page without the order sections (closed or gone) gives no order', () => {
    expect(orderFromPageText('Заказы\nПоддержка\nЗаказ скрыт', '1')).toBeNull()
  })

  it('FR-CONV-2: chat bubbles get their author from the layout, an unknown class stays unknown', async () => {
    await ab.page.setContent(CHAT)
    const r = await profiParsers.fromChatDom(ab.page, '95100001')
    expect(r.recognized).toBe(true)
    expect(
      r.signals.map((s) =>
        s.t === 'message' ? [s.message.platform_message_id, s.message.author] : null,
      ),
    ).toEqual([
      ['m1', 'specialist'],
      ['m2', 'client'],
      ['m3', 'system'],
      ['m4', 'unknown'],
    ])
  })

  it('FR-CONV-2: a kept chat record gives each bubble the author its page would, an unknown class stays unknown', () => {
    // The shape the tab keeps of a chat page (no text), so calibration samples can be checked for authors.
    expect(authorFromClasses(['cw_msg', 'cw_iCsdtF', 'cw_QbW5I0'])).toBe('specialist')
    expect(authorFromClasses(['cw_cO7-r-'])).toBe('client')
    expect(authorFromClasses(['cw_GK6qZJ'])).toBe('system')
    expect(authorFromClasses(['cw_msg', 'cw_ZZZ999'])).toBe('unknown')
    expect(authorFromClasses([])).toBe('unknown')
  })

  it('FR-SET-4: the wallet balance is read from the top bar', async () => {
    await ab.page.setContent(FEED)
    expect(await profiParsers.fromHeaderDom(ab.page)).toContainEqual({ t: 'balance', rub: 23 })
  })

  it('FR-SET-4: the wallet is read by its «Баланс» label wherever the top bar draws it', async () => {
    // Old Sara, paymentPanel.js (25.09.2026): two elements carry the label, with the same amount.
    await ab.page.setContent(
      '<div class="top"><a aria-label="Баланс">1\u00a0254 ₽</a><span aria-label="Баланс">1 254 ₽</span></div>',
    )
    expect(await profiParsers.fromHeaderDom(ab.page)).toContainEqual({ t: 'balance', rub: 1254 })
  })

  it('ST-M1-07: the chats page address is found in the site menu', async () => {
    await ab.page.setContent(FEED)
    expect(await profiParsers.chatsUrl?.(ab.page)).toBe('/backoffice/chats.php')
  })

  it('ST-M1-06: the real addresses are those old Sara used', () => {
    expect(profiParsers.paths.feed).toBe('/backoffice/n.php')
    expect(profiParsers.paths.order?.('7')).toBe('/backoffice/n.php?o=7')
    expect(profiParsers.paths.chat('7')).toBe('/backoffice/r.php?id=7')
  })

  it('ST-M1-06: the orders board answer of GraphQL gives each order with its place, client and budget', () => {
    // Shape recorded on the live site 24.10.2026 (values here are made up).
    const body = {
      data: {
        boSearchBoardItems: {
          items: [
            {
              id: '95300001',
              type: 'SNIPPET',
              title: 'Реклама на ТВ',
              description: 'Нужны федеральные каналы',
              geo: {
                remote: {
                  prefix: 'Дистанционно · Москва',
                  suffix: '',
                  address: null,
                  geoplaces: null,
                },
                clientMayCome: { prefix: null, suffix: null, address: null, geoplaces: null },
                orderLocation: { prefix: null, suffix: null, address: null, geoplaces: null },
              },
              price: { value: '50 000', prefix: 'до', suffix: '₽', bonusLabel: null },
              clientInfo: { name: 'Андрей' },
              lastUpdateDate: 1792824677,
            },
            { id: 'promo-1', type: 'BANNER', title: 'Скидка' },
          ],
          totalCount: 1,
        },
      },
    }
    const r = profiParsers.fromResponse('https://profi.ru/graphql', body)
    expect(r.recognized).toBe(true)
    expect(r.what).toBe('feed')
    expect(r.signals).toHaveLength(1)
    expect(r.signals[0]).toMatchObject({
      t: 'order',
      order: {
        order_id: '95300001',
        title: 'Реклама на ТВ',
        text: 'Нужны федеральные каналы',
        city: 'Дистанционно · Москва',
        client_name: 'Андрей',
        budget_text: 'до 50 000 ₽',
      },
      published_at: new Date(1792824677 * 1000).toISOString(),
    })
  })

  it('ADR-002: other GraphQL answers are not mistaken for the board', () => {
    expect(
      profiParsers.fromResponse('https://profi.ru/graphql', { data: { me: { id: 1 } } }).recognized,
    ).toBe(false)
  })

  it('FR-LEAD-9: the wallet comes from the profile answer of the site', () => {
    const body = {
      data: { balance: 23, currency: '₽', debt: 0, bonus: { value: 0 } },
      meta: { method: 'getProfile' },
      errors: [],
    }
    expect(profiParsers.fromResponse('https://profi.ru/backoffice/api/', body)).toEqual({
      recognized: true,
      signals: [{ t: 'balance', rub: 23 }],
    })
  })

  it('FR-CONV-1: chats are listed at r.php, the menu link «Чаты»', () => {
    expect(profiParsers.paths.chats).toBe('/backoffice/r.php')
  })

  it('FR-CONV-1: a chat notice of the event stream names the order chat to read', () => {
    // SockJS frames as recorded live 24.10.2026 (numbers here are made up).
    const order = String.raw`a["{\"type\":\"MSG_CHAT_ORDER_NOTIFY\",\"containerId\":1,\"orderId\":95300001,\"messengerType\":\"ORDER\",\"messengerExtId\":95300001}"]`
    const unread = String.raw`a["{\"type\":\"MSG_MESSENGER_UNREAD_NOTIFY\",\"containerId\":1,\"messengerType\":\"ORDER\",\"messengerExtId\":95300001,\"messageId\":1900000001}"]`
    expect(profiParsers.fromRtp(order)).toEqual({
      recognized: true,
      what: 'stream',
      signals: [{ t: 'chat_touched', chatId: '95300001', messageId: null }],
    })
    expect(profiParsers.fromRtp(unread).signals).toEqual([
      { t: 'chat_touched', chatId: '95300001', messageId: '1900000001' },
    ])
  })

  it('ADR-002: the stream greeting and its open frame are known, an odd frame is not', () => {
    expect(profiParsers.fromRtp('o')).toEqual({ recognized: true, what: 'stream', signals: [] })
    const ready = String.raw`a["{\"userId\":\"x\",\"streamId\":\"s\",\"type\":\"SERVER_READY\"}"]`
    expect(profiParsers.fromRtp(ready)).toEqual({ recognized: true, what: 'stream', signals: [] })
    expect(profiParsers.fromRtp({ some: 'thing' }).recognized).toBe(false)
  })
})
