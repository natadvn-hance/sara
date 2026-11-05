import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfiOrder, SubmitBidInput } from '@sara/shared'
import { signPermit } from '@sara/shared/permit'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type BidRuntime, createBidTools, isOurBid } from '../src/bid/bidTools'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { bidAttempt, rawEvent, rawOrder } from '../src/db/schema'
import { createEyes, type Eyes } from '../src/eyes/eyes'
import { type Insurance, startInsurance } from '../src/eyes/insurance'
import { type Parsers, standInParsers } from '../src/eyes/parsers'
import { ProfiToolError } from '../src/mcp/server'
import type { SessionState } from '../src/watch/sessionWatch'
import { nodeTestUrl, openNodeTestDb, resetNodeDb } from './helpers/db'
import { loginStandIn } from './helpers/site'

const ACCOUNT = 'hance-marketing'
const SECRET = 'bid-test-secret'
const { db, close } = openNodeTestDb()
let site: ProfiSite
let ab: AccountBrowser
let eyes: Eyes
let ins: Insurance
let may = true
// The tab may stop moving in the middle of a bid: a live screen viewer comes, the IP turns wrong.
let mayAfterOpener = true
let state: SessionState = 'alive'
let visited: string[] = []

// The stand-in's own pages, with the real site's order path: its order page answers like the real one.
const parsers: Parsers = {
  ...standInParsers,
  paths: { ...standInParsers.paths, order: (id) => `/backoffice/n.php?o=${id}` },
}

beforeAll(async () => {
  site = await startProfiSite()
  ab = await openAccountBrowser({
    accountId: ACCOUNT,
    profileDir: await mkdtemp(join(tmpdir(), 'bid-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
  ab.page.on('framenavigated', (f) => {
    if (f === ab.page.mainFrame()) visited.push(f.url())
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
  site.resetBids()
  may = true
  mayAfterOpener = true
  state = 'alive'
  eyes = createEyes({ accountId: ACCOUNT, db, parsers })
  // The answer of work in the tab comes before the tab is back on the feed: let the last test's tail finish. A tail
  // that waited for may/mayAfterOpener to be reset runs only now, after the first job's answer, so the second job
  // waits for it.
  await ins?.inTab(async () => null)
  await ins?.inTab(async () => null)
  ins?.stop()
  ins = startInsurance({
    eyes,
    ab,
    baseUrl: site.url,
    parsers,
    feedEveryMs: 3_600_000,
    chatsEveryMs: 3_600_000,
    canNavigate: () => may && (mayAfterOpener || site.openerClicks === 0),
  })
  visited = []
})

const tools = (
  o: {
    eyes?: BidRuntime['eyes']
    parsers?: Parsers
    afterOrderPage?: BidRuntime['afterOrderPage']
    clientMs?: number
    closeMs?: number
    confirmMs?: number
    chatLookMs?: number
    retryLookMs?: number
  } = {},
) =>
  createBidTools({
    db,
    permitSecret: SECRET,
    parsers: o.parsers ?? parsers,
    answerMs: 5000,
    closeMs: o.closeMs ?? 3000,
    lookAgainMs: 300,
    confirmMs: o.confirmMs ?? 1500,
    chatLookMs: o.chatLookMs ?? 300,
    orderLookMs: 2000,
    retryLookMs: o.retryLookMs ?? 0,
    clientMs: o.clientMs ?? 1500,
    accounts: new Map([
      [
        ACCOUNT,
        {
          watch: { state: () => state },
          eyes: o.eyes ?? eyes,
          inTab: ins.inTab,
          page: () => ab.page,
          afterOrderPage: o.afterOrderPage,
        },
      ],
    ]),
  })

/** A bid input signed like the core signs it; a given permit is kept as it is. */
const bid = (orderId: string, more: Partial<SubmitBidInput> = {}): SubmitBidInput => {
  const unsigned = {
    account_id: ACCOUNT,
    order_id: orderId,
    text: 'Ирина, добрый день! Сделаем сайт с онлайн-записью. Какие услуги клиники в приоритете?',
    price_rub: 15000,
    max_fee_rub: 1000,
    not_after: new Date(Date.now() + 5 * 60_000).toISOString(),
    idempotency_key: `k-${orderId}-${Math.random()}`,
    ...more,
  }
  return { ...unsigned, permit: more.permit ?? signPermit(SECRET, unsigned) }
}
const pressesWritten = async () => (await db.select().from(bidAttempt)).length

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof ProfiToolError) return e.errorClass
    throw e
  }
  return 'no error'
}

/** The order as the eyes stored it from the board (the page was never read). */
async function seen(id: string, more: Partial<ProfiOrder> = {}) {
  await eyes.onParsed(
    {
      recognized: true,
      what: 'feed',
      signals: [
        {
          t: 'order',
          order: {
            order_id: id,
            title: 'Сайт для клиники',
            category: 'Создание сайтов',
            city: 'Краснодар',
            text: 'Нужен сайт с онлайн-записью',
            client_name: 'Ирина',
            budget_text: 'до 150 000 ₽',
            bid_price_rub: 0,
            seen_at: new Date().toISOString(),
            ...more,
          },
          published_at: '2026-10-24T10:00:00.000Z',
        },
      ],
    },
    'response',
  )
}
const chatVisits = (id: string) => visited.filter((u) => u.includes(`/chats/${id}`)).length
const orderVisits = (id: string) => visited.filter((u) => u.includes(`n.php?o=${id}`)).length

describe('get_order on the order page (FR-LEAD-5)', () => {
  it('FR-LEAD-5: get_order opens the order page and reads open, fee and has_bid from its answer', async () => {
    const id = site.addOrder({ price: 71 })
    await seen(id)
    const o = await tools().getOrder({ account_id: ACCOUNT, order_id: id })
    expect(o).toMatchObject({
      order_id: id,
      title: 'Сайт для клиники',
      open: true,
      bid_price_rub: 71,
      has_bid: false,
      published_at: '2026-10-24T10:00:00.000Z',
    })
    expect(orderVisits(id)).toBe(1)
  }, 60000)

  it('FR-LEAD-5: a closed order reads open: false', async () => {
    const id = site.addOrder({ open: false })
    await seen(id)
    expect((await tools().getOrder({ account_id: ACCOUNT, order_id: id })).open).toBe(false)
  }, 60000)

  it('FR-LEAD-5: an order whose answer is bare (no form, tariff or price, no bid of ours), as a closed one is read live, reads open: false', async () => {
    const id = site.addOrder({ bare: true })
    await seen(id)
    expect(await tools().getOrder({ account_id: ACCOUNT, order_id: id })).toMatchObject({
      from_page: true,
      open: false,
    })
  }, 60000)

  it('FR-LEAD-5: a bare answer of an order this account bid on is not a closed order', async () => {
    const id = site.addOrder({ bare: true, hasBid: true })
    await seen(id)
    expect(await tools().getOrder({ account_id: ACCOUNT, order_id: id })).toMatchObject({
      from_page: true,
      open: true,
      has_bid: true,
    })
  }, 60000)

  it('FR-LEAD-5: get_order says its numbers come from the page when it read the page', async () => {
    const id = site.addOrder({ price: 71 })
    await seen(id)
    expect(await tools().getOrder({ account_id: ACCOUNT, order_id: id })).toMatchObject({
      from_page: true,
      open: true,
      bid_price_rub: 71,
    })
  }, 60000)

  it('FR-LEAD-5: an order whose form is gone, but which the page does not mark closed, is not called closed', async () => {
    const id = site.addOrder({ price: 71 })
    await seen(id)
    // A changed layout: no form and no disabled block. Only the site saying «closed» closes an order.
    site.bidSettings.formShown = false
    expect(await tools().getOrder({ account_id: ACCOUNT, order_id: id })).toMatchObject({
      from_page: true,
      open: true,
    })
  }, 60000)

  it('FR-LEAD-5: a page that gave no answer is not a read page, unless the page itself says the order is closed', async () => {
    site.bidSettings.answer = false
    const live = site.addOrder({ price: 71 })
    const closed = site.addOrder({ open: false })
    await seen(live)
    await seen(closed)
    const t = tools({ clientMs: 300 })
    expect(await t.getOrder({ account_id: ACCOUNT, order_id: live })).toMatchObject({
      from_page: false,
    })
    expect(await t.getOrder({ account_id: ACCOUNT, order_id: closed })).toMatchObject({
      from_page: true,
      open: false,
    })
  }, 60000)

  const KLIENT = {
    name: 'Ирина',
    title: 'На Профи.ру с 7 сентября 2020',
    verified: true,
    positive: 3,
    negative: 1,
    tags: ['Перестала отвечать'],
  }

  it("FR-LEAD-5: get_order gives the site's own lines about the client too (Profi Pro)", async () => {
    const id = site.addOrder({
      price: 71,
      klient: {
        ...KLIENT,
        summaries: [
          {
            image: 'https://cdn.profi.ru/client-info/summaries/message-x-red.png',
            colorTheme: 'RED',
            description: 'Договаривается меньше, чем в 20% заказов',
            renderInOrder: true,
          },
        ],
      },
    })
    await seen(id)
    const o = await tools().getOrder({ account_id: ACCOUNT, order_id: id })
    expect(o.client_info?.summaries).toEqual([
      {
        description: 'Договаривается меньше, чем в 20% заказов',
        color_theme: 'RED',
        percent: 20,
      },
    ])
  }, 60000)

  it('FR-LEAD-5: get_order gives the client of the order page: since when, the number, the reviews and their tags', async () => {
    const id = site.addOrder({ price: 71, klient: KLIENT })
    await seen(id)
    const o = await tools().getOrder({ account_id: ACCOUNT, order_id: id })
    expect(o.client_info).toEqual({
      name: 'Ирина',
      on_profi_since: 'На Профи.ру с 7 сентября 2020',
      phone_verified: true,
      reviews: { positive: 3, negative: 1 },
      review_tags: ['Перестала отвечать'],
    })
  }, 60000)

  it('FR-LEAD-5: the client answer is the one of the order asked about, never of the order read before', async () => {
    const a = site.addOrder({ klient: { ...KLIENT, name: 'Анна' } })
    const b = site.addOrder({ klient: { ...KLIENT, name: 'Борис', tags: [] } })
    await seen(a)
    await seen(b)
    const t = tools()
    expect((await t.getOrder({ account_id: ACCOUNT, order_id: a })).client_info?.name).toBe('Анна')
    expect((await t.getOrder({ account_id: ACCOUNT, order_id: b })).client_info).toMatchObject({
      name: 'Борис',
      review_tags: [],
    })
    expect((await t.getOrder({ account_id: ACCOUNT, order_id: a })).client_info?.name).toBe('Анна')
  }, 60000)

  it('FR-LEAD-5: a client answer that comes a little after the page opened is still taken; the next order without one gets none', async () => {
    const slow = site.addOrder({ klient: { ...KLIENT, name: 'Опоздавшая' } })
    const next = site.addOrder({ klient: null })
    await seen(slow)
    await seen(next)
    site.bidSettings.klientDelayMs = 1500
    const t = tools({ clientMs: 500 })
    const late = await t.getOrder({ account_id: ACCOUNT, order_id: slow })
    expect(late).toMatchObject({ open: true, bid_price_rub: 210, has_bid: false })
    expect(late.client_info?.name).toBe('Опоздавшая')
    // The next order has no client answer at all: the one just read must not be taken for it.
    const o = await t.getOrder({ account_id: ACCOUNT, order_id: next })
    expect(o.client_info ?? null).toBeNull()
  }, 60000)

  it('FR-LEAD-5: a client answer asked for by a frame of the page, not by the order page itself, is left out', async () => {
    const id = site.addOrder({ klient: { ...KLIENT, name: 'Ирина' } })
    await seen(id)
    site.bidSettings.klientDecoy = true
    // The widget's answer comes first; only the order page's own is the client of this order.
    site.bidSettings.klientDelayMs = 400
    const o = await tools().getOrder({ account_id: ACCOUNT, order_id: id })
    expect(o.client_info?.name).toBe('Ирина')
    expect(o.client_info?.review_tags).toEqual(['Перестала отвечать'])
  }, 60000)

  it('FR-LEAD-5: a page without the client answer still gives the order, with no client_info', async () => {
    const id = site.addOrder({ price: 71, klient: null })
    await seen(id)
    const o = await tools({ clientMs: 500 }).getOrder({ account_id: ACCOUNT, order_id: id })
    expect(o).toMatchObject({ open: true, bid_price_rub: 71 })
    expect(o.client_info ?? null).toBeNull()
  }, 60000)

  const withPageText = (client: string, text: string): Parsers => ({
    ...parsers,
    async fromOrderDom(_page, orderId) {
      return {
        recognized: true,
        what: 'order',
        signals: [
          {
            t: 'order',
            order: {
              order_id: orderId,
              title: 'Сайт для клиники',
              category: '',
              city: '',
              text,
              client_name: client,
              budget_text: null,
              bid_price_rub: 0,
              seen_at: new Date().toISOString(),
            },
            published_at: null,
          },
        ],
      }
    },
  })

  it('FR-LEAD-5: the client name and the text the board lacked come from the order page', async () => {
    const id = site.addOrder({ price: 71, klient: null })
    await seen(id, { client_name: '', text: '' })
    const o = await tools({
      parsers: withPageText('Ирина', 'Полный текст страницы'),
      clientMs: 300,
    }).getOrder({
      account_id: ACCOUNT,
      order_id: id,
    })
    expect(o).toMatchObject({ client_name: 'Ирина', text: 'Полный текст страницы' })
  }, 60000)

  it('FR-LEAD-5: what the board did show is kept, the page does not overwrite it', async () => {
    const id = site.addOrder({ price: 71, klient: null })
    await seen(id, { client_name: 'Андрей', text: 'Текст доски' })
    const o = await tools({
      parsers: withPageText('Ирина', 'Текст страницы'),
      clientMs: 300,
    }).getOrder({
      account_id: ACCOUNT,
      order_id: id,
    })
    expect(o).toMatchObject({ client_name: 'Андрей', text: 'Текст доски' })
  }, 60000)

  it('FR-LEAD-5: a client name neither the board nor the page gave is taken from the client answer', async () => {
    const id = site.addOrder({ price: 71, klient: { ...KLIENT, name: 'Ольга' } })
    await seen(id, { client_name: '' })
    const o = await tools().getOrder({ account_id: ACCOUNT, order_id: id })
    expect(o.client_name).toBe('Ольга')
  }, 60000)

  it('FR-LEAD-8: each order page visit of get_order hands the page to the form calibration, and a tab that may not move does not', async () => {
    const id = site.addOrder({ price: 71 })
    await seen(id)
    const visits: string[] = []
    const t = tools({ afterOrderPage: async (orderId) => void visits.push(orderId) })
    await t.getOrder({ account_id: ACCOUNT, order_id: id })
    // The calibration runs after the answer, before the tab leaves the page.
    await ins.inTab(async () => null)
    expect(visits).toEqual([id])
    may = false
    await t.getOrder({ account_id: ACCOUNT, order_id: id })
    await ins.inTab(async () => null)
    expect(visits).toEqual([id])
  }, 60000)

  it('FR-LEAD-8: get_order leaves a map of the bid form in node.raw_event, nothing clicked', async () => {
    const id = site.addOrder({ price: 71 })
    await seen(id)
    await tools().getOrder({ account_id: ACCOUNT, order_id: id })
    // The map is written after the answer, before the tab leaves the page.
    await ins.inTab(async () => null)
    const maps = (await db.select().from(rawEvent)).filter(
      (r) => (r.body as { what?: string } | null)?.what === 'bid_form',
    )
    expect(maps.length).toBeGreaterThanOrEqual(1)
    expect(site.openerClicks).toBe(0)
  }, 60000)

  it('FR-LEAD-5: when the tab may not move, get_order answers from what the eyes saw', async () => {
    const id = site.addOrder({ price: 71 })
    await seen(id, { bid_price_rub: 64 })
    may = false
    const o = await tools().getOrder({ account_id: ACCOUNT, order_id: id })
    expect(o).toMatchObject({ bid_price_rub: 64, has_bid: null, from_page: false })
    expect(orderVisits(id)).toBe(0)
  }, 60000)
})

describe('submit_bid through the site form (FR-LEAD-8, NFR-REL-4)', () => {
  it('FR-LEAD-8: submit_bid fills the price and the text, sends, and confirms the bid on the page', async () => {
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    const out = await tools().submitBid(input)
    expect(out).toEqual({ found_on_page: true, spent_rub: 71, balance_after_rub: 4929 })
    expect(site.bids).toEqual([{ orderId: id, price: '15000', priceTo: '23000', text: input.text }])
    const maps = (await db.select().from(rawEvent)).filter(
      (r) => (r.body as { what?: string } | null)?.what === 'bid_form',
    )
    expect(maps.length).toBeGreaterThan(0)
    // The tab goes back to the feed, where the event stream lives.
    await ins.inTab(async () => null)
    expect(ab.page.url()).toContain('/backoffice/a.php')
  }, 60000)

  it('FR-LEAD-8: a confirmed bid is remembered on the stored order', async () => {
    const id = site.addOrder({ price: 71 })
    await seen(id)
    await tools().submitBid(bid(id))
    const [row] = await db.select().from(rawOrder)
    expect((row?.body as { has_bid?: boolean } | undefined)?.has_bid).toBe(true)
  }, 60000)

  it('FR-LEAD-8: a null price leaves «Стоимость услуги» empty', async () => {
    const id = site.addOrder({ price: 71, priceRequired: false })
    await tools().submitBid(bid(id, { price_rub: null }))
    expect(site.bids.map((b) => b.price)).toEqual([''])
  }, 60000)

  it('FR-LEAD-8: a missing price the site requires stops the bid before any click', async () => {
    const id = site.addOrder({ price: 71, priceRequired: true })
    expect(await failure(tools().submitBid(bid(id, { price_rub: null })))).toBe('INTERNAL')
    expect(site.bids).toEqual([])
    expect(site.openerClicks).toBe(0)
  }, 60000)

  it('NFR-REL-4: an order already bid on gives found_on_page and 0 ₽, with nothing clicked', async () => {
    const id = site.addOrder({ price: 71, hasBid: true })
    expect(await tools().submitBid(bid(id))).toEqual({
      found_on_page: true,
      spent_rub: 0,
      balance_after_rub: 5000,
      already_there: true,
    })
    expect(site.bids).toEqual([])
    expect(site.openerClicks).toBe(0)
  }, 60000)

  it('FR-LEAD-8: a closed order is ORDER_CLOSED', async () => {
    const id = site.addOrder({ open: false })
    expect(await failure(tools().submitBid(bid(id)))).toBe('ORDER_CLOSED')
    expect(site.openerClicks).toBe(0)
  }, 60000)

  it('FR-LEAD-8: a wallet below the amount due is NO_MONEY, with nothing clicked', async () => {
    site.setBalance(50)
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('NO_MONEY')
    expect(site.openerClicks).toBe(0)
    expect(site.bids).toEqual([])
  }, 60000)

  it('FR-LEAD-8: a payment way other than the wallet is UNSAFE_PAYMENT, nothing sent', async () => {
    site.bidSettings.payWay = 'sbp'
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('UNSAFE_PAYMENT')
    expect(site.bids).toEqual([])
    expect(site.balance).toBe(5000)
  }, 60000)

  it('FR-LEAD-8: a send the site silently refused, form still open, is UNCERTAIN', async () => {
    site.bidSettings.mode = 'silent'
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('UNCERTAIN')
  }, 60000)

  it('FR-LEAD-8: a bid the order page shows only on the second look is confirmed, not unsure (30.10.2026)', async () => {
    // The site took the bid, but its order answer right after still says there is none, its bar is not refreshed, and
    // the chat shows nothing: only the order answer can tell.
    site.bidSettings.hasBidLag = 1
    site.bidSettings.barBalance = 5000
    site.bidSettings.chatBid = false
    const id = site.addOrder({ price: 71 })
    const out = await tools({ confirmMs: 8000 }).submitBid(bid(id))
    expect(out).toMatchObject({ found_on_page: true, spent_rub: 71 })
    expect(site.bids).toHaveLength(1)
  }, 60000)

  it('FR-LEAD-8: a slow send whose form closes after its first wait is confirmed, not unsure (30.10.2026)', async () => {
    site.bidSettings.postDelayMs = 4000
    const id = site.addOrder({ price: 71 })
    const out = await tools().submitBid(bid(id))
    expect(out).toMatchObject({ found_on_page: true, spent_rub: 71 })
    expect(site.bids).toHaveLength(1)
  }, 60000)

  it('FR-LEAD-8: a bid is confirmed by its text in the order chat in seconds, while hasBid and the wallet lag (95592581, 95596098)', async () => {
    // Live on 31.10.2026: the bid paid and in the chat at once, hasBid 3 to 8 minutes later, the bar not moved in 30 s.
    site.bidSettings.formStays = true
    site.bidSettings.hasBidLag = 100
    site.bidSettings.barBalance = 5000
    const id = site.addOrder({ price: 71 })
    const t0 = Date.now()
    // A form wait of 2 × 20 s, as the old wait for the form would have taken.
    const out = await tools({ closeMs: 20_000 }).submitBid(bid(id))
    expect(Date.now() - t0).toBeLessThan(15_000)
    // The bar says 5000, but the bid is there, so the money is gone.
    expect(out).toEqual({ found_on_page: true, spent_rub: 71, balance_after_rub: 4929 })
    expect(site.bids).toHaveLength(1)
    const [row] = await db.select().from(bidAttempt)
    expect(row?.result).toEqual(out)
    // One look at the chat was enough: the order page was opened only for the press.
    expect(orderVisits(id)).toBe(1)
    expect(chatVisits(id)).toBe(1)
  }, 60000)

  it('FR-LEAD-8: a bid that reaches the chat a moment later is seen on the same page load', async () => {
    site.bidSettings.chatBidDelayMs = 800
    site.bidSettings.hasBidLag = 100
    site.bidSettings.barBalance = 5000
    const id = site.addOrder({ price: 71 })
    const out = await tools({ chatLookMs: 5000, confirmMs: 8000 }).submitBid(bid(id))
    expect(out).toMatchObject({ found_on_page: true, spent_rub: 71 })
    expect(chatVisits(id)).toBe(1)
  }, 60000)

  it('FR-LEAD-8: a chat that shows the bid only later is found on the next look at it', async () => {
    site.muteRtp(true)
    try {
      site.bidSettings.chatBidDelayMs = 1000
      site.bidSettings.hasBidLag = 100
      site.bidSettings.barBalance = 5000
      const id = site.addOrder({ price: 71 })
      const out = await tools({ confirmMs: 8000 }).submitBid(bid(id))
      expect(out).toMatchObject({ found_on_page: true, spent_rub: 71 })
      expect(chatVisits(id)).toBe(2)
    } finally {
      site.muteRtp(false)
    }
  }, 60000)

  it('FR-LEAD-8: with no text to read, the order fresh line in the chats list confirms it', async () => {
    const id = site.addOrder({ price: 71 })
    const out = await tools({
      parsers: {
        ...parsers,
        fromChatDom: async () => ({ recognized: false, signals: [] }),
        chatTextsFromAnswer: undefined,
      },
    }).submitBid(bid(id))
    expect(out).toEqual({ found_on_page: false, spent_rub: 71, balance_after_rub: 4929 })
  }, 60000)

  it('FR-LEAD-8: a line in the chats list from before the press confirms nothing', async () => {
    site.bidSettings.mode = 'lost'
    const id = site.addOrder({ price: 71 })
    const old = new Date(Date.now() - 3_600_000).toISOString()
    const failed = await failure(
      tools({
        parsers: {
          ...parsers,
          chatsFromAnswer: (url) =>
            url.endsWith('/api/chats') ? [{ chatId: id, unread: 0, lastAt: old }] : null,
        },
      }).submitBid(bid(id)),
    )
    expect(failed).toBe('UNCERTAIN')
  }, 60000)

  it('FR-LEAD-8: with the chat silent and the order answer late, the wallet down by the amount due confirms it', async () => {
    site.bidSettings.chatBid = false
    site.bidSettings.formStays = true
    site.bidSettings.hasBidLag = 100
    const id = site.addOrder({ price: 71 })
    const out = await tools().submitBid(bid(id))
    expect(out).toEqual({ found_on_page: false, spent_rub: 71, balance_after_rub: 4929 })
    expect(site.bids).toHaveLength(1)
  }, 60000)

  it('FR-LEAD-8: an unsure bid costs at most four page reads, however long the looks may last', async () => {
    site.bidSettings.mode = 'silent'
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools({ confirmMs: 60_000 }).submitBid(bid(id)))).toBe('UNCERTAIN')
    expect(chatVisits(id)).toBe(2)
    // The one for the press and two looks.
    expect(orderVisits(id)).toBe(3)
  }, 60000)

  /** The eyes as the live recorder feeds them: they hear the wallet from the site's answers, here whatever is set. */
  const hearing = (rub: () => number | null): BidRuntime['eyes'] => ({
    onParsed: (...a) => eyes.onParsed(...a),
    onRaw: (...a) => eyes.onRaw(...a),
    balance: () => rub() ?? eyes.balance(),
  })

  it('FR-LEAD-8: the wallet the eyes hear go down confirms the bid at once, with no page opened (95611217)', async () => {
    // Live on 01.11.2026: the eyes heard the wallet down 2 s after the press, hasBid still false on every look.
    site.bidSettings.hasBidLag = 100
    site.bidSettings.barBalance = 5000
    site.bidSettings.formStays = true
    const id = site.addOrder({ price: 71 })
    const t = tools({ eyes: hearing(() => site.balance), closeMs: 20_000 })
    const out = await t.submitBid(bid(id))
    expect(out).toEqual({ found_on_page: false, spent_rub: 71, balance_after_rub: 4929 })
    expect(orderVisits(id)).toBe(1)
    expect(chatVisits(id)).toBe(0)
    const [row] = await db.select().from(bidAttempt)
    expect(row?.walletRub).toBe(5000)
  }, 60000)

  it('NFR-REL-4: a retry knows the wallet from before the press: the wallet down confirms it with the tab not moving', async () => {
    site.bidSettings.chatBid = false
    site.bidSettings.hasBidLag = 100
    site.bidSettings.barBalance = 5000
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    let rub: number | null = null
    const t = tools({ eyes: hearing(() => rub) })
    expect(await failure(t.submitBid(input))).toBe('UNCERTAIN')
    // The tab goes back to the feed after the answer.
    await ins.inTab(async () => null)
    visited = []
    // The tab may not move any more; the eyes hear the money gone.
    may = false
    rub = 4929
    expect(await t.submitBid(input)).toEqual({
      found_on_page: false,
      spent_rub: 71,
      balance_after_rub: 4929,
    })
    expect(visited).toEqual([])
    expect(site.bidPosts).toBe(1)
  }, 60000)

  it('FR-LEAD-8: a tab that may not move after the press still hears the wallet until the time is out', async () => {
    site.bidSettings.chatBid = false
    site.bidSettings.hasBidLag = 100
    site.bidSettings.barBalance = 5000
    // The send takes a moment, so the tab stops before the first look.
    site.bidSettings.postDelayMs = 400
    const id = site.addOrder({ price: 71 })
    let rub: number | null = null
    const stopTab = setInterval(() => {
      if (site.bidPosts === 0) return
      clearInterval(stopTab)
      may = false
      setTimeout(() => {
        rub = 4929
      }, 1000)
    }, 10)
    try {
      const out = await tools({ eyes: hearing(() => rub), confirmMs: 8000 }).submitBid(bid(id))
      expect(out).toMatchObject({ found_on_page: false, spent_rub: 71 })
    } finally {
      clearInterval(stopTab)
    }
    // The press's own order page, nothing after it.
    expect(orderVisits(id)).toBe(1)
    expect(chatVisits(id)).toBe(0)
  }, 60000)

  it('NFR-REL-4: the money of a later press does not confirm an earlier unsure one', async () => {
    site.bidSettings.mode = 'lost'
    const first = site.addOrder({ price: 71 })
    const input = bid(first)
    const t = tools({ eyes: hearing(() => site.balance) })
    expect(await failure(t.submitBid(input))).toBe('UNCERTAIN')
    // The next bid goes through: the wallet is down by its fee, the same as the first one's.
    site.bidSettings.mode = 'ok'
    const second = site.addOrder({ price: 71 })
    expect(await t.submitBid(bid(second))).toMatchObject({ spent_rub: 71 })
    expect(site.balance).toBe(4929)
    expect(await failure(t.submitBid(input))).toBe('UNCERTAIN')
  }, 60000)

  it('FR-LEAD-8: a retry opens no page so soon after the last look, and one page later', async () => {
    site.bidSettings.mode = 'silent'
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    const t = tools({ retryLookMs: 60_000 })
    expect(await failure(t.submitBid(input))).toBe('UNCERTAIN')
    // The tab goes back to the feed after the answer.
    await ins.inTab(async () => null)
    const seen = visited.length
    expect(await failure(t.submitBid(input))).toBe('UNCERTAIN')
    await ins.inTab(async () => null)
    expect(visited.length).toBe(seen)
    const fresh = tools({ retryLookMs: 0 })
    const chats = chatVisits(id)
    expect(await failure(fresh.submitBid(input))).toBe('UNCERTAIN')
    expect(chatVisits(id)).toBe(chats + 1)
  }, 60000)

  it('NFR-REL-4: a retry that only looks finds the bid in the chat and presses nothing', async () => {
    site.bidSettings.chatBid = false
    site.bidSettings.hasBidLag = 100
    site.bidSettings.barBalance = 5000
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    const t = tools()
    expect(await failure(t.submitBid(input))).toBe('UNCERTAIN')
    site.addMessage(id, 'specialist', input.text)
    expect(await t.submitBid(input)).toMatchObject({ found_on_page: true, spent_rub: 71 })
    expect(site.bidPosts).toBe(1)
  }, 60000)

  it('FR-LEAD-8: our bid in a chat is told by its text, however the site writes it', () => {
    const text =
      'Ирина, добрый день! Сделаем сайт с онлайн-записью. Какие услуги клиники в приоритете?'
    expect(isOurBid(text, text)).toBe(true)
    expect(
      isOurBid(
        'ирина,  добрый день!\nСделаем сайт с онлайн-записью. Какие услуги клиники в приоритете',
        text,
      ),
    ).toBe(true)
    expect(isOurBid(`${text} Стоимость от 15000 руб.`, text)).toBe(true)
    // A long one cut on the page.
    expect(isOurBid('Ирина, добрый день! Сделаем сайт с онлайн-записью', text)).toBe(true)
    expect(isOurBid('Ирина, добрый день!', text)).toBe(false)
    expect(isOurBid('Стоимость от 15000 до 23000 руб. усл.', text)).toBe(false)
    expect(isOurBid('', text)).toBe(false)
  })

  it('NFR-REL-4: money the opener took is not taken for the press: a lost send stays UNCERTAIN', async () => {
    site.bidSettings.openerCharges = 71
    site.bidSettings.mode = 'lost'
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('UNCERTAIN')
    expect(site.bids).toEqual([])
  }, 60000)

  it('FR-LEAD-8: a closed form without the bid on the page is UNCERTAIN', async () => {
    site.bidSettings.mode = 'lost'
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('UNCERTAIN')
  }, 60000)

  it('FR-LEAD-8: a text the field does not take whole stops the bid before the click', async () => {
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id, { text: 'а'.repeat(600) })))).toBe('INTERNAL')
    expect(site.bids).toEqual([])
  }, 60000)

  it('FR-LEAD-8: without the order page answer nothing is clicked', async () => {
    site.bidSettings.answer = false
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('LAYOUT_CHANGED')
    expect(site.openerClicks).toBe(0)
  }, 60000)

  it('FR-LEAD-8: a wrong permit is refused before the page is opened', async () => {
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id, { permit: 'ab'.repeat(32) })))).toBe('INTERNAL')
    expect(orderVisits(id)).toBe(0)
  }, 60000)

  it('FR-LEAD-8: no bid while the tab may not move, and no page opened', async () => {
    may = false
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('RATE_LIMITED')
    expect(orderVisits(id)).toBe(0)
  }, 60000)

  it('FR-LEAD-8: a logged out account is SESSION_DEAD', async () => {
    state = 'dead'
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('SESSION_DEAD')
  }, 60000)

  it('NFR-REL-4: a repeated call with the same key clicks nothing and gives the same answer', async () => {
    const id = site.addOrder({ price: 71 })
    const t = tools()
    const input = bid(id, { idempotency_key: 'same-key' })
    const first = await t.submitBid(input)
    const visits = orderVisits(id)
    expect(await t.submitBid(input)).toEqual(first)
    expect(orderVisits(id)).toBe(visits)
    expect(site.bids).toHaveLength(1)
  }, 60000)

  it('NFR-REL-4: two calls at once on one order make one bid', async () => {
    const id = site.addOrder({ price: 71 })
    const t = tools()
    const outs = await Promise.all([t.submitBid(bid(id)), t.submitBid(bid(id))])
    expect(site.bids).toHaveLength(1)
    expect(outs.map((o) => o.spent_rub).sort((a, b) => a - b)).toEqual([0, 71])
  }, 90000)

  it('NFR-REL-4: after an unconfirmed press the same key only looks, it never presses again', async () => {
    site.bidSettings.mode = 'lost'
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    expect(await failure(tools().submitBid(input))).toBe('UNCERTAIN')
    expect(await failure(tools().submitBid(input))).toBe('UNCERTAIN')
    expect(site.bidPosts).toBe(1)
    // The bid shows up on the page later: the earlier press and its money are reported.
    const order = site.orders.find((x) => x.id === id)
    if (order) order.hasBid = true
    expect(await tools().submitBid(input)).toMatchObject({ found_on_page: true, spent_rub: 71 })
    expect(site.bidPosts).toBe(1)
  }, 90000)

  it('NFR-REL-4: after a press a retry that cannot look is UNCERTAIN, never a failure', async () => {
    site.bidSettings.mode = 'lost'
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    expect(await failure(tools().submitBid(input))).toBe('UNCERTAIN')
    may = false
    expect(await failure(tools().submitBid(input))).toBe('UNCERTAIN')
    may = true
    state = 'dead'
    expect(await failure(tools().submitBid(input))).toBe('UNCERTAIN')
    site.setBalance(10)
    state = 'alive'
    expect(await failure(tools().submitBid(input))).toBe('UNCERTAIN')
    expect(site.bidPosts).toBe(1)
  }, 90000)

  it('NFR-REL-4: a confirmed bid is answered again after the session died', async () => {
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    const first = await tools().submitBid(input)
    state = 'dead'
    expect(await tools().submitBid(input)).toEqual(first)
  }, 60000)

  it('NFR-REL-4: two calls with one key at once press once and answer alike', async () => {
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    const t = tools()
    const [a, b] = await Promise.all([t.submitBid(input), t.submitBid(input)])
    expect(b).toEqual(a)
    expect(site.bidPosts).toBe(1)
  }, 90000)

  it('FR-LEAD-8: an answer that does not say has_bid presses nothing', async () => {
    site.bidSettings.hasBidField = false
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('LAYOUT_CHANGED')
    expect(site.bidPosts).toBe(0)
  }, 60000)

  it('FR-LEAD-8: a wallet not read from the page itself presses nothing', async () => {
    await eyes.onParsed({ recognized: false, signals: [{ t: 'balance', rub: 5000 }] }, 'dom')
    site.setBalance(50)
    site.bidSettings.showWallet = false
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('LAYOUT_CHANGED')
    expect(site.bidPosts).toBe(0)
  }, 60000)

  it('FR-LEAD-8: when the tab may no longer move before the press, nothing is pressed', async () => {
    mayAfterOpener = false
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('RATE_LIMITED')
    expect(site.bidPosts).toBe(0)
  }, 60000)

  it('FR-LEAD-8: a broken step before the press is INTERNAL, not UNCERTAIN', async () => {
    const id = site.addOrder({ price: 71 })
    const broken: BidRuntime['eyes'] = {
      ...eyes,
      onParsed: async () => {
        throw new Error('database is down')
      },
    }
    expect(await failure(tools({ eyes: broken }).submitBid(bid(id)))).toBe('INTERNAL')
    expect(site.bidPosts).toBe(0)
  }, 60000)

  it('FR-LEAD-8: the form opens by the words the order answer names, whatever they are', async () => {
    site.bidSettings.opener = 'words'
    site.bidSettings.openerText = 'Предложить услуги'
    const id = site.addOrder({ price: 71 })
    expect(await tools().submitBid(bid(id))).toMatchObject({ spent_rub: 71 })
    expect(site.openerClicks).toBe(1)
  }, 60000)

  it('FR-LEAD-9: a fee above the most the core allowed is PRICE_CHANGED, with nothing pressed', async () => {
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id, { max_fee_rub: 70 })))).toBe('PRICE_CHANGED')
    expect(site.openerClicks).toBe(0)
    expect(site.bidPosts).toBe(0)
    expect(await pressesWritten()).toBe(0)
  }, 60000)

  it("FR-LEAD-9: «Продолжить» beside a fee other than the order's presses nothing", async () => {
    site.bidSettings.openerAmount = 70
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id, { max_fee_rub: 71 })))).toBe('LAYOUT_CHANGED')
    expect(site.openerClicks).toBe(0)
    expect(await pressesWritten()).toBe(0)
  }, 60000)

  it('FR-LEAD-9: a permit signed for another fee or deadline is refused', async () => {
    const id = site.addOrder({ price: 71 })
    const signed = bid(id, { max_fee_rub: 70 })
    expect(await failure(tools().submitBid({ ...signed, max_fee_rub: 1000 }))).toBe('INTERNAL')
    const later = new Date(Date.now() + 60 * 60_000).toISOString()
    expect(await failure(tools().submitBid({ ...signed, not_after: later }))).toBe('INTERNAL')
    expect(orderVisits(id)).toBe(0)
  }, 60000)

  it('NFR-REL-4: after its deadline a call presses nothing and opens no page', async () => {
    const id = site.addOrder({ price: 71 })
    const past = new Date(Date.now() - 1000).toISOString()
    expect(await failure(tools().submitBid(bid(id, { not_after: past })))).toBe('RATE_LIMITED')
    expect(orderVisits(id)).toBe(0)
  }, 60000)

  it('NFR-REL-4: a call the core gave up on presses nothing, its written press goes', async () => {
    const id = site.addOrder({ price: 71 })
    // The core hangs up right after the opener was pressed.
    const signal = {
      get aborted() {
        return site.openerClicks > 0
      },
    } as AbortSignal
    expect(await failure(tools().submitBid(bid(id), signal))).toBe('RATE_LIMITED')
    expect(site.openerClicks).toBe(1)
    expect(site.bidPosts).toBe(0)
    expect(await pressesWritten()).toBe(0)
    const aborted = AbortSignal.abort()
    expect(await failure(tools().submitBid(bid(site.addOrder()), aborted))).toBe('RATE_LIMITED')
  }, 60000)

  it('FR-LEAD-8: the press is written before the opener; a stop after a wallet drop stays UNCERTAIN', async () => {
    site.bidSettings.openerCharges = 10
    const id = site.addOrder({ price: 71 })
    const input = bid(id, { text: 'а'.repeat(600) })
    expect(await failure(tools().submitBid(input))).toBe('UNCERTAIN')
    expect(await pressesWritten()).toBe(1)
    // The retry only looks: no second opener, no send.
    expect(await failure(tools().submitBid(input))).toBe('UNCERTAIN')
    expect(site.openerClicks).toBe(1)
    expect(site.bidPosts).toBe(0)
  }, 90000)

  it('FR-LEAD-8: a stop after the opener with the wallet unchanged clears the written press', async () => {
    const id = site.addOrder({ price: 71 })
    const key = `k-${id}`
    expect(
      await failure(tools().submitBid(bid(id, { idempotency_key: key, text: 'а'.repeat(600) }))),
    ).toBe('INTERNAL')
    expect(await pressesWritten()).toBe(0)
    expect(await tools().submitBid(bid(id, { idempotency_key: key }))).toMatchObject({
      spent_rub: 71,
    })
  }, 90000)

  it("FR-LEAD-8: a page without a tariff block opens its form by the order card's «Откликнуться» (31.10.2026)", async () => {
    // Order 95590077: «Цена отклика» and one «Откликнуться», no «Продолжить», no «Написать клиенту».
    site.bidSettings.opener = 'card'
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    expect(await tools().submitBid(input)).toMatchObject({ found_on_page: true, spent_rub: 71 })
    expect(site.openerClicks).toBe(1)
    expect(site.bids).toEqual([{ orderId: id, price: '15000', priceTo: '23000', text: input.text }])
  }, 60000)

  it('FR-LEAD-8: two such «Откликнуться» on the card press nothing', async () => {
    site.bidSettings.opener = 'card'
    site.bidSettings.openers = 2
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('LAYOUT_CHANGED')
    expect(site.openerClicks).toBe(0)
    expect(await pressesWritten()).toBe(0)
  }, 60000)

  it('FR-LEAD-8: a form open from the start is filled without pressing its opener', async () => {
    site.bidSettings.behindOpener = false
    const id = site.addOrder({ price: 71 })
    expect(await tools().submitBid(bid(id))).toMatchObject({ spent_rub: 71 })
    expect(site.openerClicks).toBe(0)
  }, 60000)
})

describe('get_order of an order the eyes never stored (FR-LEAD-5)', () => {
  it('FR-LEAD-5: the order is read from its page and stored', async () => {
    const id = site.addOrder({ price: 71, subject: 'Лендинг для школы' })
    const withPage: Parsers = {
      ...parsers,
      async fromOrderDom(page, orderId) {
        await page.waitForSelector('#order h1', { timeout: 5000 })
        return {
          recognized: true,
          what: 'order',
          signals: [
            {
              t: 'order',
              order: {
                order_id: orderId,
                title: await page.locator('#order h1').innerText(),
                category: '',
                city: '',
                text: '',
                client_name: '',
                budget_text: null,
                bid_price_rub: 0,
                seen_at: new Date().toISOString(),
              },
              published_at: null,
            },
          ],
        }
      },
    }
    expect(await failure(tools().getOrder({ account_id: ACCOUNT, order_id: id }))).toBe('NOT_FOUND')
    const o = await tools({ parsers: withPage }).getOrder({ account_id: ACCOUNT, order_id: id })
    expect(o).toMatchObject({ title: 'Лендинг для школы', open: true, bid_price_rub: 71 })
  }, 60000)
})

describe('a failed bid says which step said no (31.10.2026, order 95590077)', () => {
  /** The node's log lines a call left, while it runs. */
  async function logged(p: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '))
    })
    try {
      await p().catch(() => {})
    } finally {
      spy.mockRestore()
    }
    return lines
  }
  const bidLines = (lines: string[]) => lines.filter((l) => /^(BID|UNCERTAIN) /.test(l))

  it('FR-OPS-4: a confirmed bid says what confirmed it and how many seconds after the press', async () => {
    site.bidSettings.hasBidLag = 100
    const id = site.addOrder({ price: 71 })
    const lines = bidLines(await logged(() => tools().submitBid(bid(id))))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      new RegExp(
        `^BID ${id}: подтверждён в чате заказа через \\d+ с, форма закрылась; чат: отклик есть, `,
      ),
    )
  }, 60000)

  it('FR-OPS-4: an unsure bid says what each look saw: the chat, hasBid and the wallet, no words of a chat', async () => {
    site.bidSettings.mode = 'silent'
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    const lines = bidLines(await logged(() => tools({ confirmMs: 5000 }).submitBid(input)))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('чат: отклика нет, пузырей 0, в ответе 0')
    expect(lines[0]).toContain('заказ: hasBid false, кошелёк 5000')
    expect(lines[0]).not.toContain(input.text.slice(0, 20))
  }, 60000)

  it('FR-OPS-4: a retry that finds nothing is one line too, and says what it knows', async () => {
    site.bidSettings.mode = 'silent'
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    const t = tools({ retryLookMs: 60_000 })
    await failure(t.submitBid(input))
    const lines = bidLines(await logged(() => t.submitBid(input)))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('повтор после нажатия')
    expect(lines[0]).toContain('смотрели только что')
    expect(lines[0]).toContain('кошелёк до нажатия 5000')
  }, 60000)

  it('FR-OPS-4: a refusal leaves one log line with the class, the step, the message and what the page showed', async () => {
    site.bidSettings.openerAmount = 70
    const id = site.addOrder({ price: 71 })
    const lines = bidLines(await logged(() => tools().submitBid(bid(id, { max_fee_rub: 71 }))))
    expect(lines).toEqual([
      `BID ${id} LAYOUT_CHANGED на шаге «кнопка открытия формы»: Форма отклика не открылась: на «Продолжить» 70 ₽, а в заказе 71 ₽, отклик не нажат (цена 71 ₽, кошелёк 5000 ₽)`,
    ])
  }, 60000)

  it('FR-OPS-4: a page the node could not read leaves its outline and what the node saw, without any text', async () => {
    site.bidSettings.openerAmount = 70
    const id = site.addOrder({ price: 71 })
    const input = bid(id, { max_fee_rub: 71 })
    await logged(() => tools().submitBid(input))
    const kept = (await db.select().from(rawEvent))
      .map((r) => r.body as { what?: string; [k: string]: unknown })
      .filter((b) => b.what === 'bid_refused')
    expect(kept).toEqual([
      expect.objectContaining({
        orderId: id,
        step: 'кнопка открытия формы',
        feeRub: 71,
        walletRub: 5000,
        opener: { why: 'opener_fee', shownRub: 70 },
      }),
    ])
    expect(kept[0]?.shape).toEqual(expect.arrayContaining([expect.any(Object)]))
    expect(JSON.stringify(kept)).not.toContain(input.text.slice(0, 20))
  }, 60000)

  it('FR-OPS-4: a wallet the top bar does not show is named so, at its step', async () => {
    site.bidSettings.showWallet = false
    const id = site.addOrder({ price: 71 })
    const lines = bidLines(await logged(() => tools().submitBid(bid(id))))
    expect(lines).toEqual([
      `BID ${id} LAYOUT_CHANGED на шаге «ответ страницы заказа»: Не прочитал кошелёк в шапке страницы, отклик не нажат (цена 71 ₽)`,
    ])
  }, 60000)

  it('FR-OPS-4: every failure is one line: money short, a refused send, a permit that does not fit', async () => {
    site.setBalance(50)
    const poor = site.addOrder({ price: 71 })
    expect(bidLines(await logged(() => tools().submitBid(bid(poor))))).toEqual([
      `BID ${poor} NO_MONEY на шаге «ответ страницы заказа»: В кошельке 50 ₽, а отклик стоит 71 ₽ (цена 71 ₽, кошелёк 50 ₽)`,
    ])
    site.resetBids()
    site.bidSettings.mode = 'silent'
    const silent = site.addOrder({ price: 71 })
    const unsure = bidLines(await logged(() => tools().submitBid(bid(silent))))
    expect(unsure).toHaveLength(1)
    expect(unsure[0]).toMatch(new RegExp(`^UNCERTAIN ${silent}: `))
    site.resetBids()
    const id = site.addOrder({ price: 71 })
    expect(
      bidLines(await logged(() => tools().submitBid(bid(id, { permit: 'ab'.repeat(32) })))),
    ).toEqual([
      `BID ${id} INTERNAL на шаге «разрешение ядра»: Разрешение ядра не подходит к отклику`,
    ])
  }, 90000)
})
