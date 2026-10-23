import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { outboxNode } from '../src/db/schema'
import { createEyes } from '../src/eyes/eyes'
import { startInsurance } from '../src/eyes/insurance'
import { standInParsers } from '../src/eyes/parsers'
import { attachRecorder } from '../src/eyes/recorder'
import { createConnectionGuard, probeSite } from '../src/watch/connectionGuard'
import { nodeTestUrl, openNodeTestDb, resetNodeDb } from './helpers/db'
import { loginStandIn } from './helpers/site'

const { db, close } = openNodeTestDb()
afterAll(close)
beforeEach(() => resetNodeDb(db))

const MIN = 60_000
const types = async () =>
  (await db.select().from(outboxNode)).map((r) => (r.payload as { type: string }).type)

function guardWith(up: { v: boolean }, backs: string[]) {
  return createConnectionGuard({
    db,
    accountId: 'hance-marketing',
    probe: async () => up.v,
    onBack: async (since) => {
      backs.push(since)
    },
  })
}

describe('connection guard', () => {
  it('ADR-021: a short outage under 30 minutes sends nothing to Boris', async () => {
    const up = { v: true }
    const backs: string[] = []
    const g = guardWith(up, backs)
    const t0 = Date.parse('2026-10-23T10:00:00.000Z')
    up.v = false
    await g.tick(t0)
    await g.tick(t0 + 10 * MIN)
    up.v = true
    await g.tick(t0 + 15 * MIN)
    expect(await types()).toEqual([])
    expect(backs).toHaveLength(1)
  })

  it('ADR-021: a long outage sends one lost and one back message', async () => {
    const up = { v: false }
    const g = guardWith(up, [])
    const t0 = Date.parse('2026-10-23T10:00:00.000Z')
    for (const m of [0, 5, 10, 30, 35, 40, 120]) await g.tick(t0 + m * MIN)
    expect(g.online()).toBe(false)
    up.v = true
    await g.tick(t0 + 125 * MIN)
    await g.tick(t0 + 126 * MIN)
    expect(await types()).toEqual(['profi.connection_lost', 'profi.connection_back'])
  })

  it('ADR-021: while offline the site is asked once per 5 minutes', async () => {
    let asked = 0
    const g = createConnectionGuard({
      db,
      accountId: 'hance-marketing',
      probe: async () => {
        asked++
        return false
      },
      onBack: async () => {},
    })
    const t0 = Date.parse('2026-10-23T10:00:00.000Z')
    for (let s = 0; s <= 10 * 60; s += 30) await g.tick(t0 + s * 1000)
    expect(asked).toBe(3)
  })
})

describe('outage with the stand-in site', () => {
  let site: ProfiSite
  let ab: AccountBrowser
  beforeAll(async () => {
    site = await startProfiSite()
    ab = await openAccountBrowser({
      accountId: 'hance-marketing',
      profileDir: await mkdtemp(join(tmpdir(), 'guard-')),
      proxy: null,
      headless: true,
      databaseUrl: nodeTestUrl(),
    })
  }, 60000)
  afterAll(async () => {
    await ab.close()
    await site.close()
  })

  it('ADR-021: messages written during the outage arrive after it, none lost', async () => {
    const eyes = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    await attachRecorder(ab, {
      accountId: 'hance-marketing',
      rtpHost: site.rtpHost,
      profiHosts: [new URL(site.url).host],
      onRaw: (r) => eyes.onRaw(r),
    })
    await loginStandIn(ab.page, site)
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers: standInParsers,
      feedEveryMs: 3_600_000,
      chatsEveryMs: 3_600_000,
    })
    const g = createConnectionGuard({
      db,
      accountId: 'hance-marketing',
      probe: () => probeSite(ab, site.url),
      onBack: (since) => ins.reconcile(since),
    })
    const t0 = Date.now()
    await g.tick(t0)
    site.offline(true)
    await g.tick(t0 + MIN + 1000)
    expect(g.online()).toBe(false)
    site.offline(false)
    site.addMessage('c-9', 'client', 'первое')
    site.addMessage('c-9', 'client', 'второе')
    await g.tick(t0 + 7 * MIN)
    ins.stop()
    expect((await types()).filter((t) => t === 'profi.client_message')).toHaveLength(2)
  }, 60000)
})
