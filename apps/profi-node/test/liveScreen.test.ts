import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { serveMcp } from '../src/mcp/http'
import { createProfiMcpServer } from '../src/mcp/server'
import { registerScreenRoute } from '../src/screen/screenRoute'
import { nodeTestUrl } from './helpers/db'

let site: ProfiSite
let ab: AccountBrowser
let svc: Awaited<ReturnType<typeof serveMcp>>
const notUsed = () => Promise.reject(new Error('not used'))

beforeAll(async () => {
  site = await startProfiSite()
  ab = await openAccountBrowser({
    accountId: 'hance-marketing',
    profileDir: await mkdtemp(join(tmpdir(), 'screen-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
  await ab.page.goto(`${site.url}/login`)
  svc = await serveMcp(
    () =>
      createProfiMcpServer({
        sessionHealth: notUsed,
        listFeed: notUsed,
        getOrder: notUsed,
        listChats: notUsed,
        readChat: notUsed,
        submitBid: notUsed,
      }),
    0,
  )
  registerScreenRoute(svc.http, {
    nodeToken: 'node-tok',
    browsers: new Map([['hance-marketing', ab]]),
  })
}, 60000)
afterAll(async () => {
  await svc.close()
  await ab.close()
  await site.close()
})

const wsUrl = () => svc.url.replace('http', 'ws').replace('/mcp', '/screen/hance-marketing')

type Frame = { frame: string; w: number; h: number }
const frames = new WeakMap<WebSocket, Frame[]>()

function open(token: string | null): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl(), { headers: token ? { 'x-sara-node-token': token } : {} })
  const got: Frame[] = []
  frames.set(ws, got)
  ws.on('message', (m) => got.push(JSON.parse(String(m))))
  return new Promise((ok, fail) => {
    ws.on('open', () => ok(ws))
    ws.on('unexpected-response', (_req, res) => fail(new Error(`status ${res.statusCode}`)))
    ws.on('error', fail)
  })
}

async function nextFrame(ws: WebSocket): Promise<Frame> {
  const got = frames.get(ws) ?? []
  await expect.poll(() => got.length, { timeout: 10000 }).toBeGreaterThan(0)
  return got[0] as Frame
}

describe('live screen', () => {
  it('FR-SET-4: frames of the account tab arrive on the live screen', async () => {
    const ws = await open('node-tok')
    const f = await nextFrame(ws)
    expect(f.frame.length).toBeGreaterThan(100)
    expect(f.w).toBeGreaterThan(0)
    ws.close()
  }, 30000)

  it('FR-ACC-6: text typed on the live screen lands in the login field of the tab', async () => {
    const ws = await open('node-tok')
    await nextFrame(ws)
    const box = await ab.page.locator('#phone').boundingBox()
    const vp = ab.page.viewportSize()
    if (!box || !vp) throw new Error('no layout')
    ws.send(
      JSON.stringify({
        t: 'click',
        x: (box.x + box.width / 2) / vp.width,
        y: (box.y + box.height / 2) / vp.height,
      }),
    )
    ws.send(JSON.stringify({ t: 'text', text: '+79000000001' }))
    await expect
      .poll(() => ab.page.locator('#phone').inputValue(), { timeout: 5000 })
      .toBe('+79000000001')
    ws.close()
  }, 30000)

  it('T4: the service screen without the node token is refused', async () => {
    await expect(open(null)).rejects.toThrow(/401/)
  })
})
