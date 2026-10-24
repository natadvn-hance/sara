import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfiOrder, SubmitBidInput } from '@sara/shared'
import { signPermit } from '@sara/shared/permit'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type BidRuntime, createBidTools } from '../src/bid/bidTools'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { rawEvent, rawOrder } from '../src/db/schema'
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
let mayAfterContinue = true
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
  mayAfterContinue = true
  state = 'alive'
  eyes = createEyes({ accountId: ACCOUNT, db, parsers })
  ins?.stop()
  ins = startInsurance({
    eyes,
    ab,
    baseUrl: site.url,
    parsers,
    feedEveryMs: 3_600_000,
    chatsEveryMs: 3_600_000,
    canNavigate: () => may && (mayAfterContinue || site.continueClicks === 0),
  })
  visited = []
})

const tools = (o: { eyes?: BidRuntime['eyes']; parsers?: Parsers } = {}) =>
  createBidTools({
    db,
    permitSecret: SECRET,
    parsers: o.parsers ?? parsers,
    answerMs: 5000,
    closeMs: 3000,
    accounts: new Map([
      [
        ACCOUNT,
        {
          watch: { state: () => state },
          eyes: o.eyes ?? eyes,
          inTab: ins.inTab,
          page: () => ab.page,
        },
      ],
    ]),
  })

const bid = (orderId: string, more: Partial<SubmitBidInput> = {}): SubmitBidInput => {
  const key = more.idempotency_key ?? `k-${orderId}-${Math.random()}`
  return {
    account_id: ACCOUNT,
    order_id: orderId,
    text: 'Ирина, добрый день! Сделаем сайт с онлайн-записью. Какие услуги клиники в приоритете?',
    price_rub: 15000,
    idempotency_key: key,
    permit: signPermit(SECRET, key),
    ...more,
  }
}

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

  it('FR-LEAD-5: when the tab may not move, get_order answers from what the eyes saw', async () => {
    const id = site.addOrder({ price: 71 })
    await seen(id, { bid_price_rub: 64 })
    may = false
    const o = await tools().getOrder({ account_id: ACCOUNT, order_id: id })
    expect(o).toMatchObject({ bid_price_rub: 64, has_bid: null })
    expect(orderVisits(id)).toBe(0)
  }, 60000)
})

describe('submit_bid through the site form (FR-LEAD-8, NFR-REL-4)', () => {
  it('FR-LEAD-8: submit_bid fills the price and the text, sends, and confirms the bid on the page', async () => {
    const id = site.addOrder({ price: 71 })
    const input = bid(id)
    const out = await tools().submitBid(input)
    expect(out).toEqual({ found_on_page: true, spent_rub: 71, balance_after_rub: 4929 })
    expect(site.bids).toEqual([{ orderId: id, price: '15000', text: input.text }])
    const maps = (await db.select().from(rawEvent)).filter(
      (r) => (r.body as { what?: string } | null)?.what === 'bid_form',
    )
    expect(maps.length).toBeGreaterThan(0)
    // The tab goes back to the feed, where the event stream lives.
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
    expect(site.continueClicks).toBe(0)
  }, 60000)

  it('NFR-REL-4: an order already bid on gives found_on_page and 0 ₽, with nothing clicked', async () => {
    const id = site.addOrder({ price: 71, hasBid: true })
    expect(await tools().submitBid(bid(id))).toEqual({
      found_on_page: true,
      spent_rub: 0,
      balance_after_rub: 5000,
    })
    expect(site.bids).toEqual([])
    expect(site.continueClicks).toBe(0)
  }, 60000)

  it('FR-LEAD-8: a closed order is ORDER_CLOSED', async () => {
    const id = site.addOrder({ open: false })
    expect(await failure(tools().submitBid(bid(id)))).toBe('ORDER_CLOSED')
    expect(site.continueClicks).toBe(0)
  }, 60000)

  it('FR-LEAD-8: a wallet below the amount due is NO_MONEY, with nothing clicked', async () => {
    site.setBalance(50)
    const id = site.addOrder({ price: 71 })
    expect(await failure(tools().submitBid(bid(id)))).toBe('NO_MONEY')
    expect(site.continueClicks).toBe(0)
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
    expect(site.continueClicks).toBe(0)
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
    mayAfterContinue = false
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

  it('FR-LEAD-8: a form open from the start is filled without «Продолжить»', async () => {
    site.bidSettings.behindContinue = false
    const id = site.addOrder({ price: 71 })
    expect(await tools().submitBid(bid(id))).toMatchObject({ spent_rub: 71 })
    expect(site.continueClicks).toBe(0)
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
