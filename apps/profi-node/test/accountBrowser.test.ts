import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { openAccountBrowser } from '../src/browser/accountBrowser'
import { checkEgress } from '../src/browser/egress'
import { acquireAccountLock } from '../src/browser/lock'
import { nodeTestUrl } from './helpers/db'
import { startTestSocks } from './helpers/socks'

let site: ProfiSite
let socks: Awaited<ReturnType<typeof startTestSocks>>
beforeAll(async () => {
  site = await startProfiSite()
  socks = await startTestSocks()
})
afterAll(async () => {
  await site.close()
  await socks.close()
})

const opts = async () => ({
  accountId: 'hance-marketing',
  profileDir: await mkdtemp(join(tmpdir(), 'profile-')),
  proxy: null as string | null,
  headless: true,
  databaseUrl: nodeTestUrl(),
})

describe('account browser', () => {
  it('ADR-003: a second browser on the same profile is refused and the first keeps working', async () => {
    const o = await opts()
    const a = await openAccountBrowser(o)
    await expect(openAccountBrowser(o)).rejects.toThrow(/SECOND_BROWSER/)
    await a.page.goto(`${site.url}/login`)
    expect(await a.page.title()).toBe('Вход на Профи.ру')
    await a.close()
    const again = await openAccountBrowser(o)
    await again.close()
  }, 60000)

  it('ADR-003: a lock file left by a previous container with a pid that is alive now does not block the start', async () => {
    const o = await opts()
    await writeFile(join(o.profileDir, '.sara-lock'), String(process.pid))
    const a = await openAccountBrowser(o)
    await a.close()
  }, 60000)

  it('ADR-003: the account lock lives in the database, so another process or container is refused', async () => {
    const first = await acquireAccountLock(nodeTestUrl(), 'acc-lock-test')
    await expect(acquireAccountLock(nodeTestUrl(), 'acc-lock-test')).rejects.toThrow(
      /SECOND_BROWSER/,
    )
    await first()
    const again = await acquireAccountLock(nodeTestUrl(), 'acc-lock-test')
    await again()
  })

  it('FR-ACC-1: all tab traffic goes through the account SOCKS proxy', async () => {
    const a = await openAccountBrowser({ ...(await opts()), proxy: socks.url })
    await a.page.goto(`${site.url}/login`)
    expect(socks.targets.some((t) => t.endsWith(`:${new URL(site.url).port}`))).toBe(true)
    await a.close()
  }, 60000)

  it('FR-ACC-1: a tab whose IP differs from the account IP is reported', async () => {
    const a = await openAccountBrowser({ ...(await opts()), proxy: socks.url })
    expect(await checkEgress(a.page, `${site.url}/ip`, '203.0.113.9')).toEqual({
      ok: false,
      seen: '127.0.0.1',
    })
    expect(await checkEgress(a.page, `${site.url}/ip`, '127.0.0.1')).toEqual({
      ok: true,
      seen: '127.0.0.1',
    })
    await a.close()
  }, 60000)

  it('FR-ACC-1: the IP check of a browser that closed answers not ok instead of crashing', async () => {
    const a = await openAccountBrowser(await opts())
    await a.context.close()
    expect(await checkEgress(a.page, `${site.url}/ip`, '127.0.0.1')).toEqual({
      ok: false,
      seen: null,
    })
    await a.close()
  }, 60000)

  it('ST-M1-07: code run in the tab may use the __name helper tsx adds on the server', async () => {
    // On the server the node runs under tsx, which wraps every inner function in __name(...). A page has no
    // __name, so page reads with inner functions failed silently there (24.10.2026: no form maps, no chat shapes).
    const ab = await openAccountBrowser(await opts())
    try {
      expect(await ab.page.evaluate('__name(() => 7, "seven")()')).toBe(7)
      await ab.page.goto(`${site.url}/login`)
      expect(await ab.page.evaluate('__name(() => 8, "eight")()')).toBe(8)
      const other = await ab.context.newPage()
      await other.goto(`${site.url}/login`)
      expect(await other.evaluate('typeof __name')).toBe('function')
      await other.close()
    } finally {
      await ab.close()
    }
  })
})
