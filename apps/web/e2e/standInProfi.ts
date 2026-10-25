// Test-only Profi-MCP for the panel tests: the stand-in site in one account tab, MCP on 7171, controls on 18083.

import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startProfiSite } from '../../../tests/fakes/profiSite/server'
import { openAccountBrowser } from '../../profi-node/src/browser/accountBrowser'
import { serveMcp } from '../../profi-node/src/mcp/http'
import { createProfiMcpServer } from '../../profi-node/src/mcp/server'
import { registerScreenRoute } from '../../profi-node/src/screen/screenRoute'
import { dbUrl } from './dbUrl'

const site = await startProfiSite()
const ab = await openAccountBrowser({
  accountId: 'hance-marketing',
  profileDir: await mkdtemp(join(tmpdir(), 'web-e2e-profile-')),
  proxy: null,
  headless: true,
  // The lock needs only a database that always exists; sara_web is created by the core's start in parallel.
  databaseUrl: dbUrl('postgres'),
})
await ab.page.goto(`${site.url}/login`)
const no = () => Promise.reject(new Error('not used in panel tests'))
const svc = await serveMcp(
  () =>
    createProfiMcpServer({
      sessionHealth: async () => {
        const alive = !ab.page.url().includes('/login')
        return { alive, balance_rub: alive ? 5000 : null, presence: alive, egress_ip: '127.0.0.1' }
      },
      listFeed: no,
      getOrder: no,
      listChats: no,
      readChat: no,
      submitBid: no,
      sendMessage: no,
    }),
  7171,
)
registerScreenRoute(svc.http, {
  nodeToken: 'dev-node-token',
  browsers: new Map([['hance-marketing', ab]]),
})

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/_control/health') return res.writeHead(200).end('ok')
  if (url.pathname === '/_control/code')
    return res.writeHead(200).end(JSON.stringify({ code: site.code }))
  if (url.pathname === '/_control/state') {
    const phone = await ab.page
      .locator('#phone')
      .inputValue({ timeout: 500 })
      .catch(() => null)
    const code = await ab.page
      .locator('#code')
      .inputValue({ timeout: 500 })
      .catch(() => null)
    const error = await ab.page
      .locator('#error')
      .textContent({ timeout: 500 })
      .catch(() => null)
    return res.writeHead(200).end(JSON.stringify({ url: ab.page.url(), phone, code, error }))
  }
  if (url.pathname === '/_control/box') {
    const box = await ab.page.locator(url.searchParams.get('sel') ?? 'body').boundingBox()
    const vp = ab.page.viewportSize() ?? { width: 1280, height: 800 }
    if (!box) return res.writeHead(404).end()
    return res.writeHead(200).end(
      JSON.stringify({
        x: (box.x + box.width / 2) / vp.width,
        y: (box.y + box.height / 2) / vp.height,
      }),
    )
  }
  res.writeHead(404).end()
}).listen(18083, '127.0.0.1')
console.log('Подставной Профи-MCP для пульта готов')
