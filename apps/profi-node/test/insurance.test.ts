import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { outboxNode, rawEvent } from '../src/db/schema'
import { createEyes } from '../src/eyes/eyes'
import { startInsurance } from '../src/eyes/insurance'
import { type Parsers, standInParsers } from '../src/eyes/parsers'
import { profiParsers } from '../src/eyes/profiParsers'
import { attachRecorder } from '../src/eyes/recorder'
import { createConnectionGuard } from '../src/watch/connectionGuard'
import { createSessionWatch } from '../src/watch/sessionWatch'
import { nodeTestUrl, openNodeTestDb, resetNodeDb } from './helpers/db'
import { loginStandIn } from './helpers/site'

const { db, close } = openNodeTestDb()
let site: ProfiSite
let ab: AccountBrowser
beforeAll(async () => {
  site = await startProfiSite()
  ab = await openAccountBrowser({
    accountId: 'hance-marketing',
    profileDir: await mkdtemp(join(tmpdir(), 'ins-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
}, 60000)
afterAll(async () => {
  await ab.close()
  await site.close()
  await close()
})
beforeEach(() => resetNodeDb(db))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('insurance and the account tab', () => {
  it('FR-ACC-6: after a logout the tab is left alone while Boris logs in on the live screen', async () => {
    await loginStandIn(ab.page, site)
    const eyes = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    const watch = createSessionWatch({
      accountId: 'hance-marketing',
      page: ab.page,
      db,
      banMarkers: [],
      onAlive: () => {},
    })
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers: standInParsers,
      feedEveryMs: 200,
      chatsEveryMs: 200,
      canNavigate: () => watch.state() !== 'dead',
    })
    await watch.tick()
    site.logout()
    await ins.feedOnce()
    await watch.tick()
    expect(watch.state()).toBe('dead')
    await ab.page.fill('#phone', '+79000000001')
    await sleep(1200)
    ins.stop()
    expect(ab.page.url()).toContain('/login')
    expect(await ab.page.locator('#phone').inputValue()).toBe('+79000000001')
  }, 60000)

  it('ADR-021: reconcile visits only chats with messages after the outage began, one at a time', async () => {
    await loginStandIn(ab.page, site)
    site.addMessage('old-chat', 'client', 'давно')
    await sleep(50)
    const since = new Date().toISOString()
    await sleep(50)
    site.addMessage('new-chat', 'client', 'только что')
    const visited: string[] = []
    const onNav = (f: { url(): string }) => visited.push(new URL(f.url()).pathname)
    ab.page.on('framenavigated', onNav)
    const eyes = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers: standInParsers,
      feedEveryMs: 3_600_000,
      chatsEveryMs: 3_600_000,
      chatPauseMs: 10,
    })
    await ins.reconcile(since)
    ins.stop()
    ab.page.off('framenavigated', onNav)
    expect(visited).toContain('/chats/new-chat')
    expect(visited).not.toContain('/chats/old-chat')
  }, 60000)

  it('ADR-021: messages written during the outage arrive after it, none lost', async () => {
    await loginStandIn(ab.page, site)
    const eyes = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    let insRef: ReturnType<typeof startInsurance> | null = null
    const g = createConnectionGuard({
      db,
      accountId: 'hance-marketing',
      retryMs: 0,
      onBack: async (since) => {
        await insRef?.reconcile(since)
      },
    })
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers: standInParsers,
      feedEveryMs: 3_600_000,
      chatsEveryMs: 3_600_000,
      chatPauseMs: 10,
      canNavigate: () => g.mayNavigate(),
      onNavigate: (ok) => g.report(ok),
    })
    insRef = ins
    site.offline(true)
    await ins.feedOnce()
    expect(g.online()).toBe(false)
    site.offline(false)
    site.addMessage('c-9', 'client', 'первое')
    site.addMessage('c-9', 'client', 'второе')
    await sleep(1000)
    await ins.feedOnce()
    const messages = async () =>
      (await db.select().from(outboxNode))
        .map((r) => (r.payload as { type: string }).type)
        .filter((t) => t === 'profi.client_message').length
    await expect.poll(messages, { timeout: 10000 }).toBe(2)
    ins.stop()
  }, 60000)

  it('ST-M1-06: a new order on the feed page is opened once and becomes an order_seen event', async () => {
    await loginStandIn(ab.page, site)
    site.muteRtp(true)
    const opened: string[] = []
    // Real feed reading (links n.php?o=) over the stand-in; its order page is read by a small stand-in reader.
    const parsers: Parsers = {
      ...standInParsers,
      paths: { ...standInParsers.paths, order: (id) => `/backoffice/n.php?o=${id}` },
      fromResponse: () => ({ recognized: false, signals: [] }),
      fromFeedDom: profiParsers.fromFeedDom,
      async fromOrderDom(page, orderId) {
        opened.push(orderId)
        await page.waitForSelector('#order h1', { timeout: 5000 })
        const title = await page.locator('#order h1').innerText()
        return {
          recognized: true,
          what: 'order',
          signals: [
            {
              t: 'order',
              order: {
                order_id: orderId,
                title,
                category: '',
                city: '',
                text: '',
                client_name: '',
                budget_text: null,
                bid_price_rub: 0,
                seen_at: new Date().toISOString(),
              },
              published_at: null,
            },
          ],
        }
      },
    }
    const eyes = createEyes({ accountId: 'hance-marketing', db, parsers })
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers,
      feedEveryMs: 3_600_000,
      chatsEveryMs: 3_600_000,
      chatPauseMs: 10,
    })
    const id = site.addOrder({ subject: 'Лендинг для школы' })
    await ins.feedOnce()
    await ins.feedOnce()
    ins.stop()
    site.muteRtp(false)
    expect(opened.filter((x) => x === id)).toHaveLength(1)
    const types = (await db.select().from(outboxNode)).map(
      (r) => r.payload as { type: string; entity: { id: string } },
    )
    expect(types.filter((t) => t.type === 'profi.order_seen' && t.entity.id === id)).toHaveLength(1)
  }, 60000)

  it('ST-M1-06: an order seen only on the board is opened once for its fee, old feed links are left alone', async () => {
    await loginStandIn(ab.page, site)
    site.muteRtp(true)
    const opened: string[] = []
    const parsers: Parsers = {
      ...standInParsers,
      paths: { ...standInParsers.paths, order: (id) => `/backoffice/n.php?o=${id}` },
      fromResponse: () => ({ recognized: false, signals: [] }),
      // The real feed page also links hundreds of old orders: while the board answers, they are not opened.
      fromFeedDom: async () => ({ recognized: true, refs: [{ orderId: '94000001', snippet: '' }] }),
      async fromOrderDom(_page, orderId) {
        opened.push(orderId)
        return {
          recognized: true,
          what: 'order',
          signals: [
            {
              t: 'order',
              order: {
                order_id: orderId,
                title: '',
                category: '',
                city: '',
                text: '',
                client_name: '',
                budget_text: null,
                bid_price_rub: 120,
                seen_at: new Date().toISOString(),
              },
              published_at: null,
            },
          ],
        }
      },
    }
    const eyes = createEyes({ accountId: 'hance-marketing', db, parsers })
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers,
      feedEveryMs: 3_600_000,
      chatsEveryMs: 3_600_000,
      chatPauseMs: 10,
    })
    await eyes.onParsed(
      {
        recognized: true,
        what: 'feed',
        signals: [
          {
            t: 'order',
            needsPage: true,
            order: {
              order_id: '95300077',
              title: 'Лендинг для школы',
              category: 'Лендинг для школы',
              city: 'Дистанционно · Москва',
              text: 'Текст с доски',
              client_name: 'Ирина',
              budget_text: null,
              bid_price_rub: 0,
              seen_at: new Date().toISOString(),
            },
            published_at: null,
          },
        ],
      },
      'response',
    )
    await ins.feedOnce()
    await ins.feedOnce()
    ins.stop()
    site.muteRtp(false)
    expect(opened).toEqual(['95300077'])
    const seen = (await db.select().from(outboxNode))
      .map((r) => r.payload as { type: string; payload: { title: string; bid_price_rub: number } })
      .filter((t) => t.type === 'profi.order_seen')
    expect(seen.map((t) => [t.payload.title, t.payload.bid_price_rub])).toEqual([
      ['Лендинг для школы', 120],
    ])
  }, 60000)

  it('ST-M1-04: the chats list page leaves the links it showed in node.raw_event, for calibration', async () => {
    await loginStandIn(ab.page, site)
    site.addMessage('c-links', 'client', 'Здравствуйте')
    const eyes = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers: standInParsers,
      feedEveryMs: 3_600_000,
      chatsEveryMs: 3_600_000,
      chatPauseMs: 10,
    })
    await ins.chatsOnce(false)
    ins.stop()
    const dom = (await db.select().from(rawEvent)).filter((r) => r.kind === 'dom')
    expect(dom).toHaveLength(1)
    const body = dom[0]?.body as { links: string[]; messages: number }
    expect(body.links).toContain('/chats/c-links')
    // Only addresses: no text of the page is kept.
    expect(JSON.stringify(body)).not.toContain('Здравствуйте')
  }, 60000)

  it('ADR-021: a page whose network never goes quiet still counts as opened, not as a lost connection', async () => {
    await loginStandIn(ab.page, site)
    const reports: boolean[] = []
    const parsers: Parsers = {
      ...standInParsers,
      paths: { ...standInParsers.paths, chats: '/backoffice/busy.php' },
    }
    const eyes = createEyes({ accountId: 'hance-marketing', db, parsers })
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers,
      feedEveryMs: 3_600_000,
      chatsEveryMs: 3_600_000,
      chatPauseMs: 10,
      onNavigate: (ok) => {
        reports.push(ok)
      },
    })
    await ins.chatsOnce(false)
    ins.stop()
    expect(reports.length).toBeGreaterThan(0)
    expect(reports.every(Boolean)).toBe(true)
    const dom = (await db.select().from(rawEvent)).filter((r) => r.kind === 'dom')
    expect((dom[0]?.body as { links: string[] } | undefined)?.links).toContain('/chats/c-busy')
  }, 90000)

  it('FR-CONV-1: a chat named by the event stream is opened on the next minute check', async () => {
    await loginStandIn(ab.page, site)
    site.addMessage('c-touched', 'client', 'Здравствуйте')
    const visited: string[] = []
    const onNav = (f: { url(): string }) => visited.push(new URL(f.url()).pathname)
    ab.page.on('framenavigated', onNav)
    const eyes = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: site.url,
      parsers: standInParsers,
      feedEveryMs: 3_600_000,
      chatsEveryMs: 3_600_000,
      chatPauseMs: 10,
    })
    await eyes.onParsed(
      {
        recognized: true,
        what: 'stream',
        signals: [{ t: 'chat_touched', chatId: 'c-touched', messageId: null }],
      },
      'rtp',
    )
    await ins.feedOnce()
    ins.stop()
    ab.page.off('framenavigated', onNav)
    expect(visited).toContain('/chats/c-touched')
    const seen = (await db.select().from(outboxNode))
      .map((r) => r.payload as { type: string; entity: { id: string } })
      .filter((t) => t.type === 'profi.client_message')
    expect(seen.map((t) => t.entity.id)).toEqual(['c-touched'])
  }, 60000)
})
