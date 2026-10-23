import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { outboxNode, rawEvent, rawMessage } from '../src/db/schema'
import { createEyes, type Eyes } from '../src/eyes/eyes'
import { startInsurance } from '../src/eyes/insurance'
import { standInParsers } from '../src/eyes/parsers'
import { attachRecorder } from '../src/eyes/recorder'
import { nodeTestUrl, openNodeTestDb, resetNodeDb } from './helpers/db'
import { loginStandIn } from './helpers/site'

const { db, close } = openNodeTestDb()
let site: ProfiSite
let ab: AccountBrowser
let eyes: Eyes

beforeAll(async () => {
  site = await startProfiSite()
  ab = await openAccountBrowser({
    accountId: 'hance-marketing',
    profileDir: await mkdtemp(join(tmpdir(), 'eyes-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
  eyes = createEyes({
    accountId: 'hance-marketing',
    db,
    parsers: standInParsers,
    layoutSilenceMs: 300,
  })
  await attachRecorder(ab, {
    accountId: 'hance-marketing',
    rtpHost: site.rtpHost,
    profiHosts: [new URL(site.url).host],
    onRaw: (r) => eyes.onRaw(r),
  })
  await loginStandIn(ab.page, site)
}, 60000)
afterAll(async () => {
  await ab.close()
  await site.close()
  await close()
})
beforeEach(async () => {
  await resetNodeDb(db)
  site.muteRtp(false)
})
afterEach(() => eyes.reset())

const events = async (type: string) =>
  (await db.select().from(outboxNode))
    .map((r) => r.payload as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type)

async function waitFor(fn: () => Promise<boolean>, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('not in time')
}

async function openWithStream(path: string) {
  await ab.page.goto(`${site.url}${path}`)
  await ab.page.waitForFunction(
    () => (window as unknown as { __RTP?: WebSocket }).__RTP?.readyState === 1,
  )
}

const insurance = () =>
  startInsurance({
    eyes,
    ab,
    baseUrl: site.url,
    parsers: standInParsers,
    feedEveryMs: 3_600_000,
    chatsEveryMs: 3_600_000,
  })

describe('eyes', () => {
  it('FR-LEAD-1: a new order pushed by the site is an order_seen event in under 60 s', async () => {
    await openWithStream('/backoffice/a.php')
    const started = Date.now()
    const id = site.addOrder({ subject: 'Таргет для кофейни' })
    await waitFor(async () =>
      (await events('profi.order_seen')).some((e) => e.payload.order_id === id),
    )
    expect(Date.now() - started).toBeLessThan(60000)
  }, 30000)

  it('FR-LEAD-1: with the event stream silent the minute check still finds the order', async () => {
    site.muteRtp(true)
    const id = site.addOrder({ subject: 'Лендинг' })
    const ins = insurance()
    await ins.feedOnce()
    ins.stop()
    expect((await events('profi.order_seen')).some((e) => e.payload.order_id === id)).toBe(true)
  }, 30000)

  it('FR-LEAD-1: one order seen by the stream, the response and the check is one event', async () => {
    await openWithStream('/backoffice/a.php')
    const id = site.addOrder({ subject: 'Сайт' })
    await waitFor(async () =>
      (await events('profi.order_seen')).some((e) => e.payload.order_id === id),
    )
    const ins = insurance()
    await ins.feedOnce()
    await ins.feedOnce()
    ins.stop()
    expect(
      (await events('profi.order_seen')).filter((e) => e.payload.order_id === id),
    ).toHaveLength(1)
  }, 30000)

  it('FR-CONV-1: a client message is a client_message event without its text', async () => {
    await openWithStream('/chats/c-1')
    const mid = site.addMessage('c-1', 'client', 'Сколько стоит сайт?')
    await waitFor(async () =>
      (await events('profi.client_message')).some((e) => e.payload.platform_message_id === mid),
    )
    const ev = (await events('profi.client_message')).find(
      (e) => e.payload.platform_message_id === mid,
    )
    expect(JSON.stringify(ev)).not.toContain('Сколько стоит')
    const raw = await db.select().from(rawMessage)
    expect(raw.find((m) => m.platformMessageId === mid)?.text).toBe('Сколько стоит сайт?')
  }, 30000)

  it('FR-CONV-2: a message with an unknown author gives author_unclear and no client_message', async () => {
    await openWithStream('/chats/c-2')
    const mid = site.addMessage('c-2', 'strange', 'кто это?')
    await waitFor(async () =>
      (await events('profi.author_unclear')).some((e) => e.payload.platform_message_id === mid),
    )
    expect(
      (await events('profi.client_message')).some((e) => e.payload.platform_message_id === mid),
    ).toBe(false)
  }, 30000)

  it('ST-M1-04: every page response and stream message is kept in node.raw_event', async () => {
    await openWithStream('/backoffice/a.php')
    site.addOrder({ subject: 'Ещё заказ' })
    await waitFor(async () => {
      const kinds = new Set((await db.select().from(rawEvent)).map((r) => r.kind))
      return kinds.has('rtp') && kinds.has('response')
    })
  }, 30000)

  it('ADR-002: when nothing can be parsed for 10 minutes one layout_changed is sent', async () => {
    site.changeLayout()
    const ins = insurance()
    await ins.feedOnce()
    await new Promise((r) => setTimeout(r, 400))
    await eyes.checkSilence()
    await eyes.checkSilence()
    ins.stop()
    expect(await events('profi.layout_changed')).toHaveLength(1)
  }, 30000)

  it('ADR-002: a broken feed is reported even while chats still parse', async () => {
    const e = createEyes({
      accountId: 'hance-marketing',
      db,
      parsers: standInParsers,
      layoutSilenceMs: 300,
    })
    await new Promise((r) => setTimeout(r, 400))
    await e.onParsed({ recognized: true, what: 'chat', signals: [] }, 'dom')
    await e.checkSilence(Date.now(), true)
    expect(await events('profi.layout_changed')).toHaveLength(1)
  })

  it('ADR-002: no layout alarm while the account is not working (logged out, offline, wrong IP)', async () => {
    const e = createEyes({
      accountId: 'hance-marketing',
      db,
      parsers: standInParsers,
      layoutSilenceMs: 300,
    })
    await new Promise((r) => setTimeout(r, 400))
    await e.checkSilence(Date.now(), false)
    await e.checkSilence(Date.now(), true)
    expect(await events('profi.layout_changed')).toHaveLength(0)
  })

  it('FR-CONV-1: one broken signal does not stop the others in the same batch', async () => {
    const e = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
    const msg = (id: string, sentAt: string) => ({
      t: 'message' as const,
      message: {
        platform_message_id: id,
        chat_id: 'c-b',
        order_id: null,
        author: 'client' as const,
        sent_at: sentAt,
        text: 'x',
        read: false,
      },
    })
    await e.onParsed(
      {
        recognized: true,
        what: 'chat',
        signals: [msg('bad', ''), msg('good', new Date().toISOString())],
      },
      'dom',
    )
    expect(
      (await events('profi.client_message')).map((x) => x.payload.platform_message_id),
    ).toEqual(['good'])
  })
})
