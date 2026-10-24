import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { startFormCalibration } from '../src/bid/calibration'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { nodeFlag, rawEvent } from '../src/db/schema'
import { createEyes, type Eyes } from '../src/eyes/eyes'
import { standInParsers } from '../src/eyes/parsers'
import { nodeTestUrl, openNodeTestDb, resetNodeDb } from './helpers/db'
import { loginStandIn } from './helpers/site'

const { db, close } = openNodeTestDb()
let site: ProfiSite
let ab: AccountBrowser
let eyes: Eyes
let now = 0
beforeAll(async () => {
  site = await startProfiSite()
  ab = await openAccountBrowser({
    accountId: 'hance-marketing',
    profileDir: await mkdtemp(join(tmpdir(), 'fc-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
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
  eyes = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
  now = Date.parse('2026-10-24T17:00:00Z')
})

const calibration = (perHour = 3) =>
  startFormCalibration({
    accountId: 'hance-marketing',
    db,
    page: () => ab.page,
    eyes,
    parsers: standInParsers,
    perHour,
    now: () => now,
  })
const may = () => true
/** The minute check opening an order page, as readNewOrders does. */
async function visit(id: string) {
  await ab.page.goto(`${site.url}/backoffice/n.php?o=${id}`)
  await ab.page.waitForLoadState('networkidle')
}
/** A visit and the hook after it, with a fresh order of the stand-in. */
async function openOne(c: ReturnType<typeof calibration>, more = {}, mayNow = may) {
  const id = site.addOrder(more)
  await visit(id)
  await c.afterOrderPage(id, mayNow)
  return id
}
type Opened = {
  opened: boolean
  openedBy: string | null
  walletBefore: number | null
  walletAfter: number | null
  fields: { tag: string; placeholder: string | null; visible: boolean }[]
  payment: { text: string; testid: string | null }[]
}
const openedMaps = async () =>
  (await db.select().from(rawEvent))
    .map((r) => r.body as Opened & { what?: string })
    .filter((b) => b.what === 'bid_form' && b.opened !== undefined)
const stops = async () => (await db.select().from(nodeFlag)).map((f) => f.name)

describe('the node opens the bid form itself to map it (Boris, 24.10.2026)', () => {
  it('FR-LEAD-8: on an open order without our bid the form is opened once and mapped, nothing filled or sent', async () => {
    const c = calibration()
    await openOne(c, { price: 216 })
    c.stop()
    expect(site.openerClicks).toBe(1)
    expect(site.bidPosts).toBe(0)
    const [m] = await openedMaps()
    // The live opener of 24.10.2026: «Продолжить» with the fee beside it, a div in the tariff block.
    expect(m).toMatchObject({
      opened: true,
      openedBy: 'Продолжить 216 ₽',
      walletBefore: 5000,
      walletAfter: 5000,
    })
    expect(m?.fields).toContainEqual(
      // The live text field has no name: its placeholder tells it.
      expect.objectContaining({
        tag: 'textarea',
        placeholder: expect.stringMatching(/^Расскажите о своём опыте/),
        visible: true,
      }),
    )
    // The footer's amount is kept beside the same amount of the tariff block (the live map of 25.10.2026 lost it).
    expect(m?.payment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'К оплате:', testid: 'bid_form_footer' }),
        expect.objectContaining({ text: '216 ₽', testid: 'bid_form_footer' }),
        expect.objectContaining({ text: 'Кошелёк', testid: 'bid_form_footer' }),
      ]),
    )
    expect(await ab.page.inputValue('#bid-text')).toBe('')
  }, 60000)

  it('FR-LEAD-8: never on an order with our bid, a closed one, one that does not say, or one without its answer', async () => {
    const c = calibration()
    await openOne(c, { hasBid: true })
    await openOne(c, { open: false })
    site.bidSettings.hasBidField = false
    await openOne(c)
    site.bidSettings.hasBidField = true
    site.bidSettings.answer = false
    await openOne(c)
    c.stop()
    expect(site.openerClicks).toBe(0)
    expect(await openedMaps()).toEqual([])
  }, 90000)

  it("FR-LEAD-8: only «Продолжить» with the order's own fee, or «Написать клиенту», is pressed", async () => {
    const c = calibration()
    site.bidSettings.openerAmount = 999
    await openOne(c, { price: 216 })
    site.bidSettings.openerAmount = null
    site.bidSettings.opener = 'words'
    for (const words of ['Откликнуться', 'Предложить услуги', 'Продолжить', '']) {
      site.bidSettings.openerText = words
      await openOne(c)
    }
    expect(site.openerClicks).toBe(0)
    site.bidSettings.openerText = 'Написать клиенту'
    await openOne(c)
    c.stop()
    expect(site.openerClicks).toBe(1)
  }, 90000)

  it('FR-LEAD-8: nothing is pressed while the tab may not move, on a stale answer, an open form or two openers', async () => {
    const c = calibration()
    await openOne(c, {}, () => false)
    const id = site.addOrder()
    await visit(id)
    now += 3 * 60_000
    await c.afterOrderPage(id, may)
    site.bidSettings.behindOpener = false
    await openOne(c)
    site.bidSettings.behindOpener = true
    site.bidSettings.openers = 2
    await openOne(c)
    c.stop()
    expect(site.openerClicks).toBe(0)
  }, 90000)

  it('FR-LEAD-8: a wallet the page does not show means no press', async () => {
    site.bidSettings.showWallet = false
    const c = calibration()
    await openOne(c)
    c.stop()
    expect(site.openerClicks).toBe(0)
  }, 60000)

  it('FR-LEAD-8: at most the hourly number of forms is opened, restarts included', async () => {
    const c = calibration(2)
    for (let i = 0; i < 3; i++) await openOne(c)
    c.stop()
    expect(site.openerClicks).toBe(2)
    const restarted = calibration(2)
    await openOne(restarted)
    expect(site.openerClicks).toBe(2)
    now += 3600_001
    await openOne(restarted)
    restarted.stop()
    expect(site.openerClicks).toBe(3)
  }, 90000)

  it('FR-LEAD-8: a wallet that went down after opening stops the self-opening for good', async () => {
    site.bidSettings.openerCharges = 10
    const c = calibration()
    await openOne(c)
    expect((await openedMaps())[0]).toMatchObject({ walletBefore: 5000, walletAfter: 4990 })
    expect(await stops()).toEqual(['form_calibration'])
    await openOne(c)
    c.stop()
    expect(site.openerClicks).toBe(1)
    // After a restart of the node too.
    const again = calibration()
    await openOne(again)
    again.stop()
    expect(site.openerClicks).toBe(1)
  }, 90000)

  it('FR-LEAD-8: a drop the top bar shows only on the next page stops it there, before any press', async () => {
    site.bidSettings.openerCharges = 10
    site.bidSettings.openerChargeShown = false
    const c = calibration()
    await openOne(c)
    expect((await openedMaps())[0]).toMatchObject({ walletBefore: 5000, walletAfter: 5000 })
    await openOne(c)
    c.stop()
    expect(site.openerClicks).toBe(1)
    expect(await stops()).toEqual(['form_calibration'])
  }, 90000)

  it('FR-LEAD-8: an opener that leads off the order page stops it', async () => {
    site.bidSettings.openerLeaves = true
    const c = calibration()
    await openOne(c)
    site.bidSettings.openerLeaves = false
    await openOne(c)
    c.stop()
    expect(site.openerClicks).toBe(1)
    expect(await stops()).toEqual(['form_calibration'])
  }, 90000)
})
