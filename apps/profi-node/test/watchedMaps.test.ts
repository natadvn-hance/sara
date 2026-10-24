import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { rawEvent } from '../src/db/schema'
import { createEyes } from '../src/eyes/eyes'
import { standInParsers } from '../src/eyes/parsers'
import { startWatchedMaps } from '../src/eyes/watchedMaps'
import { nodeTestUrl, openNodeTestDb, resetNodeDb } from './helpers/db'
import { loginStandIn } from './helpers/site'

const { db, close } = openNodeTestDb()
let site: ProfiSite
let ab: AccountBrowser
beforeAll(async () => {
  site = await startProfiSite()
  ab = await openAccountBrowser({
    accountId: 'hance-marketing',
    profileDir: await mkdtemp(join(tmpdir(), 'wm-')),
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
beforeEach(() => resetNodeDb(db))

const maps = async () =>
  (await db.select().from(rawEvent)).filter(
    (r) => r.kind === 'dom' && (r.body as { what?: string }).what === 'bid_form',
  )

describe('maps while Boris watches the live screen (calibration of the opened form)', () => {
  it('FR-LEAD-8: on an order page under watch each new look of the form is mapped, nothing pressed', async () => {
    const eyes = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    let watched = false
    const w = startWatchedMaps({
      page: () => ab.page,
      eyes,
      watched: () => watched,
      everyMs: 3_600_000,
    })
    const id = site.addOrder({ price: 216 })
    await ab.page.goto(`${site.url}/backoffice/n.php?o=${id}`)
    await ab.page.waitForSelector('#bid-opener')
    await w.once()
    expect(await maps()).toHaveLength(0)

    watched = true
    await w.once()
    await w.once()
    expect(await maps()).toHaveLength(1)

    // Boris opens the form himself on the live screen: the opened form is mapped too.
    await ab.page.click('#bid-opener')
    await ab.page.waitForSelector('#bid-text')
    await w.once()
    const all = await maps()
    expect(all).toHaveLength(2)
    const opened = all.map((r) => r.body as { watched?: boolean; fields: { name: string }[] })
    expect(opened.every((b) => b.watched === true)).toBe(true)
    expect(opened[1]?.fields.map((f) => f.name)).toContain('comments4client')
    expect(site.openerClicks).toBe(1)

    await ab.page.goto(`${site.url}/backoffice/a.php`)
    await w.once()
    expect(await maps()).toHaveLength(2)
    w.stop()
  }, 60000)
})
