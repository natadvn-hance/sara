import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { attachRecorder, type RawRecord, redactSecrets } from '../src/eyes/recorder'
import { nodeTestUrl } from './helpers/db'
import { loginStandIn } from './helpers/site'

let site: ProfiSite
let ab: AccountBrowser
const got: RawRecord[] = []
let recording = false

beforeAll(async () => {
  site = await startProfiSite()
  ab = await openAccountBrowser({
    accountId: 'rec-test',
    profileDir: await mkdtemp(join(tmpdir(), 'rec-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
  await attachRecorder(ab, {
    accountId: 'rec-test',
    rtpHost: site.rtpHost,
    profiHosts: [new URL(site.url).host],
    shouldRecord: () => recording,
    onRaw: async (r) => {
      got.push(r)
    },
  })
}, 60000)
afterAll(async () => {
  await ab.close()
  await site.close()
})

describe('recorder', () => {
  it('ADR-002: the page JavaScript sees the native WebSocket and no Sara globals', async () => {
    await loginStandIn(ab.page, site)
    const seen = await ab.page.evaluate(() => ({
      native: WebSocket.toString().includes('[native code]'),
      ours: Object.keys(window).filter((k) => k.toLowerCase().includes('sara')),
    }))
    expect(seen).toEqual({ native: true, ours: [] })
  }, 30000)

  it('ADR-022: while the session is not working nothing is recorded, then the stream is', async () => {
    got.length = 0
    recording = false
    await ab.page.goto(`${site.url}/backoffice/a.php`)
    await ab.page.waitForFunction(
      () => (window as unknown as { __RTP?: WebSocket }).__RTP?.readyState === 1,
    )
    site.addOrder({ subject: 'Не записывать' })
    await new Promise((r) => setTimeout(r, 500))
    expect(got).toHaveLength(0)
    recording = true
    site.addOrder({ subject: 'Записать' })
    await expect.poll(() => got.some((r) => r.kind === 'rtp')).toBe(true)
  }, 30000)

  it('ADR-022: tokens, phones and codes in recorded answers are hidden', () => {
    expect(
      redactSecrets({
        items: [{ id: '1', phone: '+79000000001' }],
        auth: { access_token: 'abc', refreshToken: 'r' },
        code: '1234',
      }),
    ).toEqual({ items: [{ id: '1', phone: '[скрыто]' }], auth: '[скрыто]', code: '[скрыто]' })
  })
})
