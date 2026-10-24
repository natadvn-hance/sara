import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { startFormCalibration } from '../src/bid/calibration'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { rawEvent } from '../src/db/schema'
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
/** The minute check opening an order page, as readNewOrders does. */
async function visit(id: string) {
  await ab.page.goto(`${site.url}/backoffice/n.php?o=${id}`)
  await ab.page.waitForLoadState('networkidle')
}
type Opened = {
  opened: boolean
  openedBy: string | null
  walletBefore: number | null
  walletAfter: number | null
  fields: { name: string; visible: boolean }[]
  payment: { text: string }[]
}
const openedMaps = async () =>
  (await db.select().from(rawEvent))
    .map((r) => r.body as Opened & { what?: string })
    .filter((b) => b.what === 'bid_form' && b.opened !== undefined)

describe('the node opens the bid form itself to map it (Boris, 24.10.2026)', () => {
  it('FR-LEAD-8: on an open order without our bid the form is opened once and mapped, nothing filled or sent', async () => {
    const c = calibration()
    const id = site.addOrder({ price: 216 })
    await visit(id)
    await c.afterOrderPage(id)
    c.stop()
    expect(site.openerClicks).toBe(1)
    expect(site.bidPosts).toBe(0)
    const [m] = await openedMaps()
    expect(m).toMatchObject({
      opened: true,
      openedBy: 'Написать клиенту',
      walletBefore: 5000,
      walletAfter: 5000,
    })
    expect(m?.fields).toContainEqual(
      expect.objectContaining({ name: 'comments4client', visible: true }),
    )
    expect(m?.payment.map((p) => p.text)).toContain('К оплате: 216 ₽')
    expect(await ab.page.inputValue('#bid-text')).toBe('')
  }, 60000)

  it('FR-LEAD-8: never on an order with our bid, a closed one, or one whose answer did not come', async () => {
    const c = calibration()
    for (const id of [site.addOrder({ hasBid: true }), site.addOrder({ open: false })]) {
      await visit(id)
      await c.afterOrderPage(id)
    }
    site.bidSettings.answer = false
    const silent = site.addOrder()
    await visit(silent)
    await c.afterOrderPage(silent)
    c.stop()
    expect(site.openerClicks).toBe(0)
    expect(await openedMaps()).toEqual([])
  }, 60000)

  it('FR-LEAD-8: at most the hourly number of forms is opened', async () => {
    const c = calibration(2)
    for (let i = 0; i < 3; i++) {
      const id = site.addOrder()
      await visit(id)
      await c.afterOrderPage(id)
    }
    expect(site.openerClicks).toBe(2)
    now += 3600_001
    const later = site.addOrder()
    await visit(later)
    await c.afterOrderPage(later)
    c.stop()
    expect(site.openerClicks).toBe(3)
  }, 90000)

  it('FR-LEAD-8: an opener the answer names with a paying word is never pressed', async () => {
    const c = calibration()
    for (const words of ['Откликнуться', 'Оплатить отклик']) {
      site.bidSettings.openerText = words
      const id = site.addOrder()
      await visit(id)
      await c.afterOrderPage(id)
    }
    c.stop()
    expect(site.openerClicks).toBe(0)
  }, 60000)

  it('FR-LEAD-8: a wallet that went down after opening stops the self-opening for good', async () => {
    site.bidSettings.openerCharges = 10
    const c = calibration()
    const first = site.addOrder()
    await visit(first)
    await c.afterOrderPage(first)
    expect((await openedMaps())[0]).toMatchObject({ walletBefore: 5000, walletAfter: 4990 })
    const second = site.addOrder()
    await visit(second)
    await c.afterOrderPage(second)
    c.stop()
    expect(site.openerClicks).toBe(1)
    // After a restart of the node too.
    const again = calibration()
    const third = site.addOrder()
    await visit(third)
    await again.afterOrderPage(third)
    again.stop()
    expect(site.openerClicks).toBe(1)
  }, 60000)
})
