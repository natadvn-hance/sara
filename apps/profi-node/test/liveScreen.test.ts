import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { serveMcp } from '../src/mcp/http'
import { createProfiMcpServer } from '../src/mcp/server'
import { startLiveScreen } from '../src/screen/liveScreen'
import { registerScreenRoute } from '../src/screen/screenRoute'
import { nodeTestUrl } from './helpers/db'

let site: ProfiSite
let ab: AccountBrowser
let svc: Awaited<ReturnType<typeof serveMcp>>
const viewerCounts: number[] = []
let inputAllowed = true
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
        sendMessage: notUsed,
      }),
    0,
  )
  registerScreenRoute(svc.http, {
    nodeToken: 'node-tok',
    browsers: new Map([['hance-marketing', ab]]),
    onViewers: (_id, n) => viewerCounts.push(n),
    allowInput: () => inputAllowed,
  })
}, 60000)
afterAll(async () => {
  await svc.close()
  await ab.close()
  await site.close()
}, 30000)

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

// A headless browser on a busy machine (two CI runs at once on the Mac) sends its first frame late.
async function nextFrame(ws: WebSocket): Promise<Frame> {
  const got = frames.get(ws) ?? []
  await expect.poll(() => got.length, { timeout: 30000 }).toBeGreaterThan(0)
  return got[0] as Frame
}

describe('live screen', { timeout: 45000 }, () => {
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
      .poll(() => ab.page.locator('#phone').inputValue(), { timeout: 15000 })
      .toBe('+79000000001')
    ws.close()
  }, 30000)

  it('T4: the service screen without the node token is refused', async () => {
    await expect(open(null)).rejects.toThrow(/401/)
  })

  it('FR-ACC-6: while someone watches the live screen the service knows it, and stops knowing when they leave', async () => {
    await expect.poll(() => viewerCounts.at(-1) ?? 0).toBe(0)
    const ws = await open('node-tok')
    await nextFrame(ws)
    expect(viewerCounts.at(-1)).toBe(1)
    ws.close()
    await expect.poll(() => viewerCounts.at(-1)).toBe(0)
  }, 30000)

  it('FR-ACC-1: on a wrong IP the live screen shows the tab but takes no input', async () => {
    inputAllowed = false
    await ab.page.fill('#phone', '')
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
    ws.send(JSON.stringify({ t: 'text', text: '+79000000002' }))
    await new Promise((r) => setTimeout(r, 1000))
    expect(await ab.page.locator('#phone').inputValue()).toBe('')
    ws.close()
    inputAllowed = true
  }, 30000)

  it('FR-ACC-6: the live screen keeps sending pictures of a still page, so a stuck picture never happens', async () => {
    // A page with nothing blinking: Chromium has no reason to send screencast frames.
    const still = await ab.context.newPage()
    await still.setContent('<p style="font: 20px sans-serif">Тихая страница</p>')
    const got: string[] = []
    const stop = await startLiveScreen(still, (frame) => got.push(frame))
    await new Promise((r) => setTimeout(r, 4500))
    await still.close()
    await stop()
    expect(got.length).toBeGreaterThanOrEqual(2)
  }, 30000)

  it('FR-ACC-6: text typed into the tab shows on the live screen within 2 seconds', async () => {
    const got: string[] = []
    const stop = await startLiveScreen(ab.page, (frame) => got.push(frame))
    await new Promise((r) => setTimeout(r, 600))
    const before = got.length
    await ab.page.fill('#phone', '+79000000777')
    await new Promise((r) => setTimeout(r, 2000))
    await stop()
    expect(got.length).toBeGreaterThan(before)
    expect(got.at(-1)).not.toBe(got[0])
  }, 30000)

  it('FR-ACC-6: the live screen sends at most 3 pictures a second, so a slow connection keeps up', async () => {
    const busy = await ab.context.newPage()
    // A blinking caret and an animation: Chromium repaints all the time.
    await busy.setContent(
      '<input autofocus><div style="width:50px;height:50px;background:red;animation:s 0.2s infinite alternate"></div><style>@keyframes s{to{transform:translateX(200px)}}</style>',
    )
    const got: string[] = []
    const stop = await startLiveScreen(busy, (frame) => got.push(frame))
    await new Promise((r) => setTimeout(r, 4000))
    await stop()
    await busy.close()
    expect(got.length).toBeLessThanOrEqual(13)
    expect(got.length).toBeGreaterThanOrEqual(4)
  }, 30000)
})
