import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { outboxNode, rawEvent, rawMessage, rawOrder } from '../src/db/schema'
import { createEyes, type Eyes } from '../src/eyes/eyes'
import { startInsurance } from '../src/eyes/insurance'
import { standInParsers } from '../src/eyes/parsers'
import { attachRecorder } from '../src/eyes/recorder'
import { nodeTestUrl, openNodeTestDb, resetNodeDb } from './helpers/db'
import { loginStandIn } from './helpers/site'

const { db, close } = openNodeTestDb()
let site: ProfiSite
let ab: AccountBrowser
let eyes: Eyes

beforeAll(async () => {
  site = await startProfiSite()
  ab = await openAccountBrowser({
    accountId: 'hance-marketing',
    profileDir: await mkdtemp(join(tmpdir(), 'eyes-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
  eyes = createEyes({
    accountId: 'hance-marketing',
    db,
    parsers: standInParsers,
    layoutSilenceMs: 300,
  })
  await attachRecorder(ab, {
    accountId: 'hance-marketing',
    rtpHost: site.rtpHost,
    profiHosts: [new URL(site.url).host],
    onRaw: (r) => eyes.onRaw(r),
  })
  await loginStandIn(ab.page, site)
}, 60000)
afterAll(async () => {
  await ab.close()
  await site.close()
  await close()
})
beforeEach(async () => {
  await resetNodeDb(db)
  site.muteRtp(false)
})
afterEach(() => eyes.reset())

const events = async (type: string) =>
  (await db.select().from(outboxNode))
    .map((r) => r.payload as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type)

async function waitFor(fn: () => Promise<boolean>, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('not in time')
}

async function openWithStream(path: string) {
  await ab.page.goto(`${site.url}${path}`)
  await ab.page.waitForFunction(
    () => (window as unknown as { __RTP?: WebSocket }).__RTP?.readyState === 1,
  )
}

const insurance = () =>
  startInsurance({
    eyes,
    ab,
    baseUrl: site.url,
    parsers: standInParsers,
    feedEveryMs: 3_600_000,
    chatsEveryMs: 3_600_000,
  })

describe('eyes', () => {
  it('FR-LEAD-1: a new order pushed by the site is an order_seen event in under 60 s', async () => {
    await openWithStream('/backoffice/a.php')
    const started = Date.now()
    const id = site.addOrder({ subject: 'Таргет для кофейни' })
    await waitFor(async () =>
      (await events('profi.order_seen')).some((e) => e.payload.order_id === id),
    )
    expect(Date.now() - started).toBeLessThan(60000)
  }, 30000)

  it('FR-LEAD-1: with the event stream silent the minute check still finds the order', async () => {
    site.muteRtp(true)
    const id = site.addOrder({ subject: 'Лендинг' })
    const ins = insurance()
    await ins.feedOnce()
    ins.stop()
    expect((await events('profi.order_seen')).some((e) => e.payload.order_id === id)).toBe(true)
  }, 30000)

  it('FR-LEAD-1: one order seen by the stream, the response and the check is one event', async () => {
    await openWithStream('/backoffice/a.php')
    const id = site.addOrder({ subject: 'Сайт' })
    await waitFor(async () =>
      (await events('profi.order_seen')).some((e) => e.payload.order_id === id),
    )
    const ins = insurance()
    await ins.feedOnce()
    await ins.feedOnce()
    ins.stop()
    expect(
      (await events('profi.order_seen')).filter((e) => e.payload.order_id === id),
    ).toHaveLength(1)
  }, 30000)

  it('FR-CONV-1: a client message is a client_message event without its text', async () => {
    await openWithStream('/chats/c-1')
    const mid = site.addMessage('c-1', 'client', 'Сколько стоит сайт?')
    await waitFor(async () =>
      (await events('profi.client_message')).some((e) => e.payload.platform_message_id === mid),
    )
    const ev = (await events('profi.client_message')).find(
      (e) => e.payload.platform_message_id === mid,
    )
    expect(JSON.stringify(ev)).not.toContain('Сколько стоит')
    const raw = await db.select().from(rawMessage)
    expect(raw.find((m) => m.platformMessageId === mid)?.text).toBe('Сколько стоит сайт?')
  }, 30000)

  it('FR-CONV-2: a message with an unknown author gives author_unclear and no client_message', async () => {
    await openWithStream('/chats/c-2')
    const mid = site.addMessage('c-2', 'strange', 'кто это?')
    await waitFor(async () =>
      (await events('profi.author_unclear')).some((e) => e.payload.platform_message_id === mid),
    )
    expect(
      (await events('profi.client_message')).some((e) => e.payload.platform_message_id === mid),
    ).toBe(false)
  }, 30000)

  it('ST-M1-04: every page response and stream message is kept in node.raw_event', async () => {
    await openWithStream('/backoffice/a.php')
    site.addOrder({ subject: 'Ещё заказ' })
    await waitFor(async () => {
      const kinds = new Set((await db.select().from(rawEvent)).map((r) => r.kind))
      return kinds.has('rtp') && kinds.has('response')
    })
  }, 30000)

  it('ADR-002: when nothing can be parsed for 10 minutes one layout_changed is sent', async () => {
    site.changeLayout()
    const ins = insurance()
    await ins.feedOnce()
    await new Promise((r) => setTimeout(r, 400))
    await eyes.checkSilence()
    await eyes.checkSilence()
    ins.stop()
    expect(await events('profi.layout_changed')).toHaveLength(1)
  }, 30000)

  it('ADR-002: a broken feed is reported even while chats still parse', async () => {
    const e = createEyes({
      accountId: 'hance-marketing',
      db,
      parsers: standInParsers,
      layoutSilenceMs: 300,
    })
    await new Promise((r) => setTimeout(r, 400))
    await e.onParsed({ recognized: true, what: 'chat', signals: [] }, 'dom')
    await e.checkSilence(Date.now(), true)
    expect(await events('profi.layout_changed')).toHaveLength(1)
  })

  it('ADR-002: no layout alarm while the account is not working (logged out, offline, wrong IP)', async () => {
    const e = createEyes({
      accountId: 'hance-marketing',
      db,
      parsers: standInParsers,
      layoutSilenceMs: 300,
    })
    await new Promise((r) => setTimeout(r, 400))
    await e.checkSilence(Date.now(), false)
    await e.checkSilence(Date.now(), true)
    expect(await events('profi.layout_changed')).toHaveLength(0)
  })

  it('FR-CONV-1: one broken signal does not stop the others in the same batch', async () => {
    const e = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    const msg = (id: string, sentAt: string) => ({
      t: 'message' as const,
      message: {
        platform_message_id: id,
        chat_id: 'c-b',
        order_id: null,
        author: 'client' as const,
        sent_at: sentAt,
        text: 'x',
        read: false,
      },
    })
    await e.onParsed(
      {
        recognized: true,
        what: 'chat',
        signals: [msg('bad', ''), msg('good', new Date().toISOString())],
      },
      'dom',
    )
    expect(
      (await events('profi.client_message')).map((x) => x.payload.platform_message_id),
    ).toEqual(['good'])
  })

  it('ST-M1-06: an order known only from the board waits for its page and goes out once with the fee', async () => {
    const e = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    const board = (id: string) => ({
      t: 'order' as const,
      needsPage: true,
      order: {
        order_id: id,
        title: 'Реклама на ТВ',
        category: 'Реклама на ТВ',
        city: 'Дистанционно · Москва',
        text: 'Полный текст с доски',
        client_name: 'Андрей',
        budget_text: 'до 50 000 ₽',
        bid_price_rub: 0,
        seen_at: new Date().toISOString(),
      },
      published_at: '2026-10-24T08:00:00.000Z',
    })
    await e.onParsed(
      { recognized: true, what: 'feed', signals: [board('901'), board('902')] },
      'response',
    )
    expect(await events('profi.order_seen')).toHaveLength(0)
    expect(e.ordersWantingPage()).toEqual(['901', '902'])
    // The order page knows the fee; its own reading of the text is rougher than the board's.
    await e.onParsed(
      {
        recognized: true,
        what: 'order',
        signals: [
          {
            t: 'order',
            order: {
              ...board('901').order,
              text: 'обрезано',
              budget_text: null,
              bid_price_rub: 145,
            },
            published_at: null,
          },
        ],
      },
      'dom',
    )
    // An order page that cannot be read still lets the order through, without a fee.
    await e.settleOrder('902')
    await e.onParsed({ recognized: true, what: 'feed', signals: [board('901')] }, 'response')
    const seen = await events('profi.order_seen')
    expect(seen.map((x) => [x.payload.order_id, x.payload.bid_price_rub, x.payload.text])).toEqual([
      ['901', 145, 'Полный текст с доски'],
      ['902', 0, 'Полный текст с доски'],
    ])
    expect(seen[0]?.payload.budget_text).toBe('до 50 000 ₽')
    expect(e.ordersWantingPage()).toEqual([])
  })

  const boardOrder = (id: string) => ({
    t: 'order' as const,
    needsPage: true,
    order: {
      order_id: id,
      title: 'Реклама на ТВ',
      category: 'Реклама на ТВ',
      city: 'Дистанционно · Москва',
      text: 'Полный текст с доски',
      client_name: 'Андрей',
      budget_text: 'до 50 000 ₽',
      bid_price_rub: 0,
      seen_at: new Date().toISOString(),
    },
    published_at: '2026-10-24T08:00:00.000Z',
  })
  const fee = (orderId: string, rub: number, baseRub = rub) => ({
    recognized: true,
    what: 'order' as const,
    signals: [{ t: 'order_fee' as const, orderId, rub, baseRub, hasBid: false }],
  })

  it('ST-M1-06: the fee from the order page answer is preferred to the page text, a discount too', async () => {
    const e = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    await e.onParsed({ recognized: true, what: 'feed', signals: [boardOrder('911')] }, 'response')
    await e.onParsed(fee('911', 1, 67), 'response')
    expect(await events('profi.order_seen')).toHaveLength(0)
    // The page text missed the discount and read the usual price.
    await e.onParsed(
      {
        recognized: true,
        what: 'order',
        signals: [
          {
            t: 'order',
            order: { ...boardOrder('911').order, bid_price_rub: 67 },
            published_at: null,
          },
        ],
      },
      'dom',
    )
    const seen = await events('profi.order_seen')
    expect(seen.map((x) => [x.payload.order_id, x.payload.bid_price_rub])).toEqual([['911', 1]])
    const [stored] = await db.select().from(rawOrder).where(eq(rawOrder.orderId, '911'))
    expect(stored?.body).toMatchObject({ bid_price_rub: 1, bid_base_price_rub: 67, has_bid: false })
  })

  it('ST-M1-06: an order whose page text cannot be read still goes out with the answer fee', async () => {
    const e = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    await e.onParsed({ recognized: true, what: 'feed', signals: [boardOrder('912')] }, 'response')
    await e.onParsed(fee('912', 145), 'response')
    await e.settleOrder('912')
    const seen = await events('profi.order_seen')
    expect(seen.map((x) => [x.payload.order_id, x.payload.bid_price_rub])).toEqual([['912', 145]])
  })

  it('ST-M1-06: an order page answer alone never makes an order', async () => {
    const e = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    await e.onParsed(fee('913', 88), 'response')
    expect(await events('profi.order_seen')).toHaveLength(0)
    expect(await e.knowsOrder('913')).toBe(false)
    expect(e.ordersWantingPage()).toEqual([])
  })

  it('FR-CONV-1: a chat named by the stream is read; on its first reading only the unanswered tail is news', async () => {
    const e = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    await e.onParsed(
      {
        recognized: true,
        what: 'stream',
        signals: [{ t: 'chat_touched', chatId: '95300009', messageId: '13' }],
      },
      'rtp',
    )
    expect(e.chatsTouched()).toEqual(['95300009'])
    const m = (id: string, author: 'client' | 'specialist') => ({
      t: 'message' as const,
      message: {
        platform_message_id: id,
        chat_id: '95300009',
        order_id: '95300009',
        author,
        sent_at: new Date().toISOString(),
        text: 'x',
        read: true,
      },
    })
    const first = [m('10', 'client'), m('11', 'specialist'), m('12', 'client'), m('13', 'client')]
    await e.onChatRead('95300009', { recognized: true, what: 'chat', signals: first })
    expect(e.chatsTouched()).toEqual([])
    await e.onChatRead('95300009', {
      recognized: true,
      what: 'chat',
      signals: [...first, m('14', 'specialist'), m('15', 'client')],
    })
    expect(
      (await events('profi.client_message')).map((x) => x.payload.platform_message_id),
    ).toEqual(['12', '13', '15'])
    expect((await db.select().from(rawMessage)).length).toBe(6)
  })

  it('FR-CONV-1: the chats Sara knows are those with news in the last 3 days, newest first, 3 at most', async () => {
    const e = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString()
    const read = (chat: string, id: string, at: string) =>
      e.onChatRead(chat, {
        recognized: true,
        what: 'chat',
        signals: [
          {
            t: 'message',
            message: {
              platform_message_id: id,
              chat_id: chat,
              order_id: chat,
              author: 'client',
              sent_at: at,
              text: 'x',
              read: true,
            },
          },
        ],
      })
    await read('c-old', '1', hoursAgo(80))
    await read('c-a', '2', hoursAgo(5))
    await read('c-b', '3', hoursAgo(1))
    await read('c-c', '4', hoursAgo(30))
    await read('c-d', '5', hoursAgo(50))
    await read('c-a', '6', hoursAgo(2))
    // Another account's chat is not this tab's.
    const other = createEyes({ accountId: 'hance-dev', db, parsers: standInParsers })
    await other.onChatRead('c-other', {
      recognized: true,
      what: 'chat',
      signals: [
        {
          t: 'message',
          message: {
            platform_message_id: '7',
            chat_id: 'c-other',
            order_id: 'c-other',
            author: 'client',
            sent_at: hoursAgo(0),
            text: 'x',
            read: true,
          },
        },
      ],
    })
    expect(await e.knownChats()).toEqual(['c-b', 'c-a', 'c-c'])
  })
})
