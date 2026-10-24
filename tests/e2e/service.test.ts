import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createProfiClient } from '../../apps/core/src/profi/client'
import { loadNodeConfig } from '../../apps/profi-node/src/config'
import { createNodeDb } from '../../apps/profi-node/src/db/client'
import { standInParsers } from '../../apps/profi-node/src/eyes/parsers'
import { type ProfiService, startProfiService } from '../../apps/profi-node/src/service'
import { startTestCore } from '../../apps/profi-node/test/helpers/core'
import { nodeTestUrl, resetNodeDb } from '../../apps/profi-node/test/helpers/db'
import { type ProfiSite, startProfiSite } from '../fakes/profiSite/server'

let site: ProfiSite
let core: Awaited<ReturnType<typeof startTestCore>>
let svc: ProfiService

const types = () => core.received.map((e) => e.type)
async function until(cond: () => boolean, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`not in time: ${types().join(', ')}`)
}

beforeAll(async () => {
  // Fresh node data each run: the stand-in numbers its orders from the same start every time.
  const node = createNodeDb(nodeTestUrl('sara_node_e2e'))
  await resetNodeDb(node.db)
  await node.close()
  site = await startProfiSite()
  core = await startTestCore()
  const config = {
    ...loadNodeConfig({}),
    databaseUrl: nodeTestUrl('sara_node_e2e'),
    coreEventsUrl: core.url,
    dataDir: await mkdtemp(join(tmpdir(), 'svc-')),
    port: 0,
    profiBaseUrl: site.url,
    rtpHost: site.rtpHost,
    egressEchoUrl: `${site.url}/ip`,
    accounts: [{ id: 'hance-marketing', proxy: null, egressIp: '127.0.0.1' }],
  }
  svc = await startProfiService(config, {
    tickMs: 200,
    feedEveryMs: 1000,
    chatsEveryMs: 1000,
    shipPollMs: 100,
    parsers: standInParsers,
  })
}, 60000)
afterAll(async () => {
  await svc.close()
  await site.close()
  await core.close()
})

describe('Profi-MCP service end to end', () => {
  it('ST-M1-01: the whole service sees a logout, a login, an order and a message', async () => {
    await until(() => types().includes('profi.session_dead'))
    const page = svc.page('hance-marketing')
    await page.fill('#phone', '+79000000001')
    await page.click('#send-phone')
    await page.fill('#code', site.code)
    await page.click('#send-code')
    await until(() => types().includes('profi.session_alive'))
    const orderId = site.addOrder({ subject: 'Сайт для клиники' })
    await until(() =>
      core.received.some((e) => e.type === 'profi.order_seen' && e.entity.id === orderId),
    )
    site.addMessage('c-1', 'client', 'Здравствуйте')
    await until(() => types().includes('profi.client_message'))
    expect(types().filter((t) => t === 'profi.session_dead')).toHaveLength(1)
  }, 60000)

  it('FR-LEAD-8: the service takes submit_bid over MCP and bids through the account tab', async () => {
    const orderId = site.addOrder({ subject: 'Лендинг для школы', price: 71 })
    // The core's own client, signing with the service's development secret (no SARA_PERMIT_SECRET set).
    const profi = createProfiClient({ url: svc.url, permitSecret: 'dev-permit-secret' })
    const r = await profi.submitBid({
      account_id: 'hance-marketing',
      order_id: orderId,
      text: 'Добрый день! Сделаем лендинг. Когда нужен запуск?',
      price_rub: 30000,
      idempotency_key: `bid:${orderId}`,
    })
    expect(r).toEqual({
      found_on_page: true,
      spent_rub: 71,
      balance_after_rub: 4929,
    })
    expect(site.bids.map((b) => [b.orderId, b.price])).toEqual([[orderId, '30000']])
  }, 90000)
})

describe('account on a wrong IP', () => {
  it('FR-ACC-1: an account whose tab does not leave from its own IP never opens the site and says so', async () => {
    const wrong = await startProfiService(
      {
        ...loadNodeConfig({}),
        databaseUrl: nodeTestUrl('sara_node_e2e'),
        coreEventsUrl: core.url,
        dataDir: await mkdtemp(join(tmpdir(), 'svc-wrong-')),
        port: 0,
        profiBaseUrl: site.url,
        rtpHost: site.rtpHost,
        egressEchoUrl: `${site.url}/ip`,
        accounts: [{ id: 'wrong-ip', proxy: null, egressIp: '203.0.113.9' }],
      },
      {
        tickMs: 200,
        feedEveryMs: 1000,
        chatsEveryMs: 1000,
        shipPollMs: 100,
        parsers: standInParsers,
      },
    )
    await new Promise((r) => setTimeout(r, 1500))
    expect(wrong.page('wrong-ip').url()).toBe('about:blank')
    expect(await wrong.health('wrong-ip')).toMatchObject({
      egress_ok: false,
      egress_ip: '127.0.0.1',
    })
    await wrong.close()
  }, 60000)
})
