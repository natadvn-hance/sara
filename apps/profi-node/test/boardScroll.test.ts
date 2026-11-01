import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { outboxNode, rawEvent } from '../src/db/schema'
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
    profileDir: await mkdtemp(join(tmpdir(), 'board-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
  // The site's own answers pass the eyes the way they do on the live service.
  await attachRecorder(ab, {
    accountId: 'hance-marketing',
    rtpHost: site.rtpHost,
    profiHosts: [new URL(site.url).host],
    onRaw: (r) => eyes.onRaw(r),
  })
  await ab.page.addInitScript(() => {
    const w = window as unknown as { __wheels: number }
    w.__wheels = 0
    addEventListener('wheel', () => w.__wheels++, { passive: true })
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
  site.muteRtp(true)
  site.orders.length = 0
  eyes = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
})

/** A board of 30 orders, five to a page. */
function pagedBoard(n = 30, pageSize = 5) {
  for (let i = 0; i < n; i++) site.addOrder({ subject: `Заказ ${i}` })
  site.boardPageSize = pageSize
}
const seenNow = async () =>
  (await db.select().from(outboxNode)).filter(
    (r) => (r.payload as { type: string }).type === 'profi.order_seen',
  ).length
/** The eyes store a page's orders after its answer arrives, so the count is read once it stops moving. */
const seen = async () => {
  let last = await seenNow()
  let steadySince = Date.now()
  const end = Date.now() + 5000
  while (Date.now() < end && Date.now() - steadySince < 300) {
    await new Promise((r) => setTimeout(r, 50))
    const now = await seenNow()
    if (now !== last) [last, steadySince] = [now, Date.now()]
  }
  return last
}

const insurance = (
  o: { board?: Parameters<typeof startInsurance>[0]['board']; canNavigate?: () => boolean } = {},
) =>
  startInsurance({
    eyes,
    ab,
    baseUrl: site.url,
    parsers: standInParsers,
    feedEveryMs: 3_600_000,
    chatsEveryMs: 3_600_000,
    chatPauseMs: 10,
    canNavigate: o.canNavigate,
    board: { pauseMs: 20, ...o.board },
  })

describe('the minute check scrolls the board for its next pages', () => {
  it('FR-LEAD-1: a pass loads the first pages of a long board by scrolling, as a person does, and no more', async () => {
    pagedBoard()
    const ins = insurance({ board: { pages: 3, deepEveryMs: 3_600_000 } })
    await ins.feedOnce()
    ins.stop()
    // The page itself asked for each part: the first and two more.
    expect(site.feedRequests).toBe(3)
    expect(await seen()).toBe(15)
    expect(
      await ab.page.evaluate(() => (window as unknown as { __wheels: number }).__wheels),
    ).toBeGreaterThan(0)
    // The pass leaves a note of how far it got, for calibration on the live board (no order, no text).
    const notes = (await db.select().from(rawEvent)).filter(
      (r) => (r.body as { what?: string } | null)?.what === 'board_scroll',
    )
    expect(notes.map((r) => r.body)).toEqual([
      expect.objectContaining({ what: 'board_scroll', pages: 3, wanted: 3, stoppedBy: 'pages' }),
    ])
  }, 60000)

  /** How far each pass over the board got: its note says the pages it loaded and why it stopped. */
  const passesOf = async () =>
    (await db.select().from(rawEvent))
      .map((r) => r.body as { what?: string; pages?: number; stoppedBy?: string })
      .filter((b) => b.what === 'board_scroll')
      .map((b) => [b.pages, b.stoppedBy])

  it('FR-LEAD-1: a new order deep in the board moves its count: the whole board is read at once, then the first pages again', async () => {
    pagedBoard()
    const ins = insurance({ board: { pages: 2, deepEveryMs: 3_600_000 } })
    await ins.feedOnce()
    expect(await seen()).toBe(10)
    // 95612005: a new order of low relevance lands far down the board, not on its first pages.
    const late = site.addOrder({ subject: 'Новый заказ внизу' })
    site.orders.push(site.orders.shift() as (typeof site.orders)[number])
    await ins.feedOnce()
    const events = (await db.select().from(outboxNode)).map(
      (r) => (r.payload as { type: string; entity: { id: string } }).entity.id,
    )
    expect(events).toContain(late)
    await ins.feedOnce()
    ins.stop()
    expect(await passesOf()).toEqual([
      [2, 'pages'],
      [7, 'end'],
      [2, 'pages'],
    ])
  }, 90000)

  it('FR-LEAD-1: an order closed moves the count too, and a count that keeps jittering is not read every pass', async () => {
    pagedBoard()
    const ins = insurance({ board: { pages: 2, deepEveryMs: 3_600_000, deepGapMs: 3_600_000 } })
    await ins.feedOnce()
    site.orders.pop()
    await ins.feedOnce()
    // The first move is read at once.
    site.orders.pop()
    await ins.feedOnce()
    ins.stop()
    expect(await passesOf()).toEqual([
      [2, 'pages'],
      [6, 'end'],
      [2, 'pages'],
    ])
  }, 90000)

  it('FR-LEAD-1: the whole board is read on a clock too, for a new order and a closed one cancelling out', async () => {
    pagedBoard()
    const ins = insurance({ board: { pages: 2, deepEveryMs: 0 } })
    await ins.feedOnce()
    ins.stop()
    expect(await passesOf()).toEqual([[6, 'end']])
  }, 90000)

  it('FR-LEAD-1: a start or an outage reads the whole board, whatever its count says', async () => {
    pagedBoard()
    const ins = insurance({ board: { pages: 2, deepEveryMs: 3_600_000 } })
    await ins.feedOnce({ deep: true })
    await ins.reconcile(new Date().toISOString())
    ins.stop()
    expect((await passesOf()).map((p) => p[1])).toEqual(['end', 'end'])
  }, 90000)

  it('FR-LEAD-1: a whole pass that gave way to a press is read again on the next pass', async () => {
    pagedBoard()
    const ins = insurance({ board: { pages: 2, deepEveryMs: 3_600_000, pauseMs: 200 } })
    await ins.feedOnce()
    site.addOrder({ subject: 'Новый заказ' })
    const deep = ins.feedOnce()
    await expect.poll(() => site.feedRequests, { timeout: 20000 }).toBeGreaterThan(3)
    await ins.inTab(async () => null, { urgent: true })
    await deep
    await ins.feedOnce()
    ins.stop()
    const stops = (await passesOf()).map((p) => p[1])
    expect(stops).toEqual(['pages', 'press', 'end'])
  }, 90000)

  it('FR-LEAD-1: how the page asks for the board is kept once a run, without any cookie', async () => {
    pagedBoard()
    const asking = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers: {
        ...standInParsers,
        isBoardRequest: (url) => url.includes('/api/feed'),
      },
      feedEveryMs: 3_600_000,
      chatsEveryMs: 3_600_000,
      chatPauseMs: 10,
      board: { pages: 2, deepEveryMs: 3_600_000, pauseMs: 20 },
    })
    await asking.feedOnce()
    await asking.feedOnce()
    asking.stop()
    await expect
      .poll(
        async () =>
          (await db.select().from(rawEvent)).filter(
            (r) => (r.body as { what?: string }).what === 'board_request',
          ).length,
        { timeout: 5000 },
      )
      .toBe(1)
  }, 90000)

  it('FR-LEAD-1: a board that is one page long is not scrolled', async () => {
    for (let i = 0; i < 4; i++) site.addOrder()
    const ins = insurance()
    const started = Date.now()
    await ins.feedOnce()
    ins.stop()
    expect(site.feedRequests).toBe(1)
    expect(await seen()).toBe(4)
    expect(await ab.page.evaluate(() => (window as unknown as { __wheels: number }).__wheels)).toBe(
      0,
    )
    expect(Date.now() - started).toBeLessThan(15000)
  }, 60000)

  it('FR-LEAD-1: the scrolling stops when the pass has used its time', async () => {
    pagedBoard()
    const ins = insurance({ board: { pages: 6, budgetMs: 0 } })
    await ins.feedOnce()
    ins.stop()
    expect(site.feedRequests).toBe(1)
    expect(await seen()).toBe(5)
    const notes = (await db.select().from(rawEvent)).map((r) => r.body as { stoppedBy?: string })
    expect(notes.find((b) => b.stoppedBy)?.stoppedBy).toBe('time')
  }, 60000)

  it('FR-LEAD-1: the scrolling stops when the tab may not move any more', async () => {
    pagedBoard()
    const ins = insurance({
      board: { pages: 6, deepEveryMs: 3_600_000 },
      canNavigate: () => site.feedRequests < 2,
    })
    await ins.feedOnce()
    ins.stop()
    expect(site.feedRequests).toBe(2)
    expect(await seen()).toBe(10)
    const notes = (await db.select().from(rawEvent)).map((r) => r.body as { stoppedBy?: string })
    expect(notes.find((b) => b.stoppedBy)?.stoppedBy).toBe('gate')
  }, 60000)

  it('FR-LEAD-1: a board the readers do not know is not scrolled', async () => {
    pagedBoard()
    // A changed site: its answers are not the ones the readers know, so the eyes see no board to scroll.
    const unknown = { ...standInParsers, fromResponse: () => ({ recognized: false, signals: [] }) }
    eyes = createEyes({ accountId: 'hance-marketing', db, parsers: unknown })
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers: unknown,
      feedEveryMs: 3_600_000,
      chatsEveryMs: 3_600_000,
      chatPauseMs: 10,
      board: { pages: 6, pauseMs: 20 },
    })
    await ins.feedOnce()
    ins.stop()
    expect(site.feedRequests).toBe(1)
  }, 60000)
})

type Note = {
  what: string
  pages: number
  stoppedBy: string
  worked?: string[]
  tried?: string[]
  probe?: {
    cards: number
    boxes: { tag: string; scrollHeight: number; clientHeight: number }[]
    buttons: { text: string }[]
    window: { scrollHeight: number; innerHeight: number }
  }
}
const notes = async () =>
  (await db.select().from(rawEvent))
    .map((r) => r.body as Note)
    .filter((b) => b?.what === 'board_scroll')

describe('the ways to make the board load more', () => {
  it("FR-LEAD-1: a list in its own scroll box, out of the wheel's reach, loads by the last card scrolled into view, and the way is remembered", async () => {
    pagedBoard()
    site.boardLayout = 'box'
    const ins = insurance({ board: { pages: 3, deepEveryMs: 3_600_000 } })
    await ins.feedOnce()
    expect(await seen()).toBe(15)
    await ins.feedOnce()
    ins.stop()
    expect(await seen()).toBe(15)
    const [first, second] = await notes()
    expect(first?.worked).toEqual(['last_card', 'last_card'])
    expect(first?.stoppedBy).toBe('pages')
    // The second pass goes straight to the way that worked, with no wheel first.
    expect(second?.worked).toEqual(['last_card', 'last_card'])
    expect(second?.tried).toEqual(['last_card'])
  }, 90000)

  it('FR-LEAD-1: the wheel alone does not reach a list in its own box, so the test box is a fair one', async () => {
    pagedBoard()
    site.boardLayout = 'box'
    const ins = insurance({ board: { pages: 3, ways: ['wheel'] } })
    await ins.feedOnce()
    ins.stop()
    expect(await seen()).toBe(5)
    expect((await notes())[0]?.stoppedBy).toBe('quiet')
  }, 60000)

  it('FR-LEAD-1: the scroll box itself, taken to its bottom, loads the next part', async () => {
    pagedBoard()
    site.boardLayout = 'box'
    const ins = insurance({ board: { pages: 3, ways: ['container'], deepEveryMs: 3_600_000 } })
    await ins.feedOnce()
    ins.stop()
    expect(await seen()).toBe(15)
    expect((await notes())[0]?.worked).toEqual(['container', 'container'])
  }, 60000)

  it('FR-LEAD-1: a board with a «Показать ещё» button loads by pressing it', async () => {
    pagedBoard()
    site.boardLayout = 'button'
    const ins = insurance({ board: { pages: 3, deepEveryMs: 3_600_000 } })
    await ins.feedOnce()
    ins.stop()
    expect(await seen()).toBe(15)
    expect((await notes())[0]?.worked).toEqual(['button', 'button'])
  }, 90000)

  it('FR-LEAD-1: a pass that finds no way to load more says what the page looks like, and stays short', async () => {
    pagedBoard()
    site.boardLayout = 'box'
    const ins = insurance({ board: { pages: 3, ways: ['wheel'] } })
    await ins.feedOnce()
    ins.stop()
    const [note] = await notes()
    expect(note?.tried).toEqual(['wheel'])
    expect(note?.probe?.cards).toBe(5)
    // The list sits in a box that scrolls: this is what a calibration needs to see.
    expect(note?.probe?.boxes[0]).toMatchObject({ tag: 'div' })
    expect(note?.probe?.boxes[0]?.scrollHeight).toBeGreaterThan(
      note?.probe?.boxes[0]?.clientHeight ?? 0,
    )
    // The note holds the shape of the page, never an order's words.
    expect(JSON.stringify(note)).not.toMatch(/Заказ \d/)
  }, 60000)

  it('FR-LEAD-1: with every way tried and nothing loading, the pass gives up within seconds', async () => {
    pagedBoard()
    site.boardLayout = 'none'
    const ins = insurance({ board: { pages: 3, deepEveryMs: 3_600_000 } })
    const started = Date.now()
    await ins.feedOnce()
    ins.stop()
    expect(await seen()).toBe(5)
    const [note] = await notes()
    expect(note).toMatchObject({
      stoppedBy: 'quiet',
      tried: ['wheel', 'last_card', 'container', 'button'],
    })
    expect(Date.now() - started).toBeLessThan(25000)
  }, 60000)

  it('FR-LEAD-1: a pass still running is not queued again by its timer, so the 30-second passes never stack', async () => {
    pagedBoard()
    const before = site.feedRequests
    // Here a pass of a few slow scrolls takes about a second, its timer 50 ms.
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers: standInParsers,
      feedEveryMs: 50,
      chatsEveryMs: 3_600_000,
      chatPauseMs: 10,
      board: { pages: 3, deepEveryMs: 3_600_000, pauseMs: 300 },
    })
    await new Promise((r) => setTimeout(r, 2000))
    ins.stop()
    // Whatever the timer queued still runs before this.
    await ins.inTab(async () => null)
    const passes = (site.feedRequests - before) / 3
    expect(passes).toBeGreaterThanOrEqual(1)
    expect(passes).toBeLessThanOrEqual(4)
  }, 60000)
})
