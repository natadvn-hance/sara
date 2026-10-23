import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { openAccountBrowser } from '../src/browser/accountBrowser'
import { checkEgress } from '../src/browser/egress'
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
})
