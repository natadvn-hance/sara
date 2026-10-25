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
const seen = async () =>
  (await db.select().from(outboxNode)).filter(
    (r) => (r.payload as { type: string }).type === 'profi.order_seen',
  ).length

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
    const ins = insurance({ board: { pages: 3, fullEvery: 1000 } })
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

  it('FR-LEAD-1: every Nth pass reads the whole board, the others only the first pages', async () => {
    pagedBoard()
    const ins = insurance({ board: { pages: 2, fullEvery: 2, fullPages: 20 } })
    await ins.feedOnce()
    expect(await seen()).toBe(10)
    await ins.feedOnce()
    ins.stop()
    expect(await seen()).toBe(30)
    const notes = (await db.select().from(rawEvent))
      .map((r) => r.body as { what?: string; pages?: number; stoppedBy?: string })
      .filter((b) => b.what === 'board_scroll')
    expect(notes.map((b) => [b.pages, b.stoppedBy])).toEqual([
      [2, 'pages'],
      [6, 'end'],
    ])
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
      board: { pages: 6, fullEvery: 1000 },
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
