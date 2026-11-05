import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { bidAttempt, clientSawBid, outboxNode, rawEvent } from '../src/db/schema'
import { createEyes, type Eyes } from '../src/eyes/eyes'
import { type Insurance, startInsurance } from '../src/eyes/insurance'
import { type Parsers, standInParsers } from '../src/eyes/parsers'
import { attachRecorder } from '../src/eyes/recorder'
import { nodeTestUrl, openNodeTestDb, resetNodeDb } from './helpers/db'
import { loginStandIn } from './helpers/site'

// The chat check every 2 minutes and the chats the event stream names (Boris, 31.10.2026: «чаще просматривать
// страницы»): only chats with news cost a page, and a named chat is read at once.

const { db, close } = openNodeTestDb()
let site: ProfiSite
let ab: AccountBrowser
let eyes: Eyes
let visited: string[] = []
// Only the stream frames reach the eyes, and only when a test opens the stream: the live eyes read no chat answers.
let streamOn = false
// The list's own answer, for the mark that the client saw the bid.
let answersOn = false
const running: Insurance[] = []

beforeAll(async () => {
  site = await startProfiSite()
  ab = await openAccountBrowser({
    accountId: 'hance-marketing',
    profileDir: await mkdtemp(join(tmpdir(), 'news-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
  await attachRecorder(ab, {
    accountId: 'hance-marketing',
    rtpHost: site.rtpHost,
    profiHosts: [new URL(site.url).host],
    onRaw: async (r) => {
      if ((streamOn && r.kind === 'rtp') || (answersOn && r.url?.endsWith('/api/chats')))
        await eyes.onRaw(r)
    },
  })
  ab.page.on('framenavigated', (f) => {
    if (f === ab.page.mainFrame()) visited.push(new URL(f.url()).pathname)
  })
  await loginStandIn(ab.page, site)
}, 60000)
afterAll(async () => {
  await ab.close()
  await site.close()
  await close()
})
afterEach(async () => {
  for (const ins of running.splice(0)) {
    ins.stop()
    await ins.inTab(async () => null)
  }
})
beforeEach(async () => {
  await resetNodeDb(db)
  site.streamNamesOnly(false)
  streamOn = false
  answersOn = false
  eyes = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
  visited = []
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function insurance(o: { chatsEveryMs?: number; parsers?: Parsers } = {}) {
  const ins = startInsurance({
    eyes,
    ab,
    baseUrl: site.url,
    parsers: o.parsers ?? standInParsers,
    feedEveryMs: 3_600_000,
    chatsEveryMs: o.chatsEveryMs ?? 3_600_000,
    chatPauseMs: 10,
  })
  running.push(ins)
  return ins
}

/** The notes the 2-minute check leaves of itself: what the list gave and what it opened. */
const checks = async () =>
  (await db.select().from(rawEvent))
    .map((r) => r.body as { what?: string; from?: string; news?: number; opened?: number })
    .filter((b) => b.what === 'chat_check')
const events = async (type: string) =>
  (await db.select().from(outboxNode))
    .map(
      (r) =>
        r.payload as {
          type: string
          occurred_at: string
          entity: { id: string }
          payload: { seen_via?: string }
        },
    )
    .filter((e) => e.type === type)
const chatVisits = (id: string) => visited.filter((p) => p === `/chats/${id}`).length

describe('the 2-minute chat check reads the list and opens only chats with news', () => {
  it('FR-CONV-1: only the chat the list marks unread is opened, once; a check with no news costs the list page alone', async () => {
    site.addMessage('c-old', 'client', 'Добрый день')
    // The node has read the old chat before: the site counts it read.
    await insurance().chatsOnce(false)
    site.addMessage('c-new', 'client', 'Сколько стоит сайт?')
    visited = []
    insurance({ chatsEveryMs: 400 })
    await expect.poll(async () => (await checks()).length, { timeout: 20000 }).toBeGreaterThan(1)
    const [first, second] = await checks()
    expect(first).toMatchObject({ from: 'answer', news: 1, opened: 1 })
    expect(second).toMatchObject({ from: 'answer', news: 0, opened: 0 })
    expect(chatVisits('c-new')).toBe(1)
    expect(chatVisits('c-old')).toBe(0)
    const seen = await events('profi.client_message')
    expect(seen.map((e) => [e.entity.id, e.payload.seen_via])).toEqual([
      ['c-old', 'sweep'],
      ['c-new', 'sweep'],
    ])
  }, 60000)

  it('FR-CONV-1: a chat whose last message moved with nothing unread (Boris wrote from his phone) is read once', async () => {
    site.addMessage('c-phone', 'client', 'Добрый день')
    await insurance().chatsOnce(false)
    await sleep(20)
    site.addMessage('c-phone', 'specialist', 'Пришлю расчёт завтра')
    visited = []
    insurance({ chatsEveryMs: 400 })
    await expect.poll(async () => (await checks()).length, { timeout: 20000 }).toBeGreaterThan(1)
    expect(chatVisits('c-phone')).toBe(1)
    expect((await events('profi.specialist_message')).map((e) => e.entity.id)).toEqual(['c-phone'])
  }, 60000)

  it('FR-CONV-1: a chat the node never read and the list counts read is left alone', async () => {
    site.addMessage('c-mine', 'specialist', 'Здравствуйте! Сделаем.')
    insurance({ chatsEveryMs: 400 })
    await expect.poll(async () => (await checks()).length, { timeout: 20000 }).toBeGreaterThan(0)
    expect(chatVisits('c-mine')).toBe(0)
  }, 60000)

  it('FR-CONV-1: without the list answer the check reads blind, and no more often than every 10 minutes', async () => {
    site.addMessage('c-blind', 'client', 'Добрый день')
    insurance({ chatsEveryMs: 300, parsers: { ...standInParsers, chatsFromAnswer: undefined } })
    await expect.poll(async () => (await checks()).length, { timeout: 20000 }).toBe(1)
    await sleep(1500)
    expect(await checks()).toEqual([expect.objectContaining({ from: 'page', opened: 1 })])
    expect(visited.filter((p) => p === '/chats')).toHaveLength(1)
  }, 60000)
})

describe('a chat the event stream names is read at once', () => {
  it('FR-CONV-1: the client message reaches the outbox within seconds, not at the next pass over the feed', async () => {
    site.streamNamesOnly(true)
    streamOn = true
    const ins = insurance()
    // The tab rests on the feed, where the stream is open.
    await ins.feedOnce()
    await sleep(300)
    const t0 = Date.now()
    site.addMessage('c-live', 'client', 'Здравствуйте, вы ещё принимаете заказы?')
    await expect
      .poll(async () => (await events('profi.client_message')).length, { timeout: 15000 })
      .toBe(1)
    const took = Date.now() - t0
    const [seen] = await events('profi.client_message')
    expect(seen?.entity.id).toBe('c-live')
    expect(seen?.payload.seen_via).toBe('stream')
    // The stream named the chat, the page was read at once: here well under the 30 s of the next feed pass.
    expect(took).toBeLessThan(10_000)
    // And the tab is back on the feed, where the stream lives.
    await expect.poll(() => visited.at(-1), { timeout: 10000 }).toBe('/backoffice/a.php')
  }, 60000)
})

describe('the client saw the bid, by the chats list', () => {
  /** A bid Sara made on this order: its press is written down. */
  const pressed = (id: string) =>
    db.insert(bidAttempt).values({
      idempotencyKey: `k-${id}`,
      accountId: 'hance-marketing',
      orderId: id,
      dueRub: 100,
      pressedAt: new Date().toISOString(),
    })
  const reads = async () =>
    (await db.select().from(outboxNode))
      .map(
        (r) =>
          r.payload as {
            type: string
            entity: { kind: string; id: string }
            payload: { chat_id: string; order_id: string; platform_message_id: string | null }
          },
      )
      .filter((e) => e.type === 'profi.client_read')

  it('FR-CONV-12: the mark goes once, from the list page the check reads anyway: no chat opened, nothing pressed', async () => {
    answersOn = true
    site.addMessage('95700001', 'specialist', 'Здравствуйте! Сделаем.')
    await pressed('95700001')
    insurance({ chatsEveryMs: 400 })
    await expect.poll(async () => (await checks()).length, { timeout: 20000 }).toBeGreaterThan(0)
    // Our bid stands in the chat, and the client has not opened it: nothing yet.
    expect(await reads()).toEqual([])
    site.clientSawBid('95700001')
    await expect.poll(async () => (await reads()).length, { timeout: 20000 }).toBe(1)
    const seen = (await checks()).length
    await expect.poll(async () => (await checks()).length, { timeout: 20000 }).toBeGreaterThan(seen)
    const [read] = await reads()
    expect(await reads()).toHaveLength(1)
    expect(read?.entity).toEqual({ kind: 'chat', id: '95700001' })
    expect(read?.payload).toMatchObject({
      chat_id: '95700001',
      order_id: '95700001',
      platform_message_id: null,
    })
    expect(chatVisits('95700001')).toBe(0)
  }, 60000)

  it('FR-CONV-12: after a restart of the node the same chat gets no second mark', async () => {
    await pressed('95700002')
    const signal = {
      recognized: true,
      what: 'chats',
      signals: [{ t: 'client_saw_bid', chatId: '95700002' }],
    } as const
    await eyes.onParsed({ ...signal, signals: [...signal.signals] }, 'response')
    await eyes.onParsed({ ...signal, signals: [...signal.signals] }, 'response')
    const again = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    await again.onParsed({ ...signal, signals: [...signal.signals] }, 'response')
    expect(await reads()).toHaveLength(1)
  }, 30000)

  it('FR-CONV-12: an older chat with no bid of Sara is written down without a mark, so the core makes no empty client', async () => {
    await eyes.onParsed(
      {
        recognized: true,
        what: 'chats',
        signals: [{ t: 'client_saw_bid', chatId: '95700003' }],
      },
      'response',
    )
    expect(await reads()).toEqual([])
    expect((await db.select().from(clientSawBid)).map((r) => r.chatId)).toEqual(['95700003'])
  }, 30000)
})
