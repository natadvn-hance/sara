import { join } from 'node:path'
import type { Page } from 'playwright'
import { type AccountBrowser, openAccountBrowser } from './browser/accountBrowser'
import { checkEgress } from './browser/egress'
import type { NodeConfig } from './config'
import { createNodeDb } from './db/client'
import { migrateNode } from './db/migrate'
import { createEyes } from './eyes/eyes'
import { type Insurance, startInsurance } from './eyes/insurance'
import { activeParsers } from './eyes/parsers'
import { attachRecorder } from './eyes/recorder'
import { serveMcp } from './mcp/http'
import { createProfiMcpServer } from './mcp/server'
import { registerScreenRoute } from './screen/screenRoute'
import { createShipper } from './ship/shipper'
import { purgeOld } from './store/purge'
import { type AccountRuntime, createReadTools } from './tools/readTools'
import { createConnectionGuard, probeSite } from './watch/connectionGuard'
import { createSessionWatch, type SessionWatch } from './watch/sessionWatch'

export type ServiceTimings = {
  tickMs: number
  feedEveryMs: number
  chatsEveryMs: number
  shipPollMs: number
  egressEveryMs: number
}

const DEFAULT_TIMINGS: ServiceTimings = {
  tickMs: 30000,
  feedEveryMs: 60000,
  chatsEveryMs: 600000,
  shipPollMs: 500,
  egressEveryMs: 600000,
}

export type ProfiService = { url: string; page(accountId: string): Page; close(): Promise<void> }

type Account = {
  ab: AccountBrowser
  watch: SessionWatch
  insurance: Insurance | null
  egress: { ok: boolean; seen: string | null }
  stop(): Promise<void>
}

/** The live Profi-MCP: per account a tab with its own IP, eyes, session watch and connection guard. */
export async function startProfiService(
  c: NodeConfig,
  t: Partial<ServiceTimings> = {},
): Promise<ProfiService> {
  const timing = { ...DEFAULT_TIMINGS, ...t }
  await migrateNode(c.databaseUrl)
  const { db, close: closeDb } = createNodeDb(c.databaseUrl)
  const parsers = activeParsers
  const baseHost = new URL(c.profiBaseUrl).host
  const accounts = new Map<string, Account>()
  const runtimes = new Map<string, AccountRuntime>()
  const browsers = new Map<string, AccountBrowser>()

  for (const acc of c.accounts) {
    const ab = await openAccountBrowser({
      accountId: acc.id,
      profileDir: join(c.dataDir, 'profiles', acc.id),
      proxy: acc.proxy,
      headless: c.headless,
      databaseUrl: c.databaseUrl,
    })
    browsers.set(acc.id, ab)
    const eyes = createEyes({ accountId: acc.id, db, parsers })
    await attachRecorder(ab, {
      accountId: acc.id,
      rtpHost: c.rtpHost,
      profiHosts: [baseHost],
      onRaw: (r) => eyes.onRaw(r),
    })
    const a: Account = {
      ab,
      insurance: null,
      egress: { ok: false, seen: null },
      watch: createSessionWatch({
        accountId: acc.id,
        page: ab.page,
        db,
        banMarkers: parsers.banMarkers,
        onAlive: (since) => void a.insurance?.reconcile(since).catch(() => {}),
      }),
      async stop() {},
    }
    accounts.set(acc.id, a)
    runtimes.set(acc.id, {
      watch: a.watch,
      eyes,
      egressIp: () => a.egress.seen,
      silenceMs: 600000,
    })

    const guard = createConnectionGuard({
      db,
      accountId: acc.id,
      probe: () => probeSite(ab, c.profiBaseUrl),
      onBack: async (since) => {
        await a.insurance?.reconcile(since)
      },
    })

    // The site is opened only from the account's own IP (FR-ACC-1); until then the tab stays away from it.
    const start = async () => {
      a.egress = await checkEgress(ab.page, c.egressEchoUrl, acc.egressIp)
      if (!a.egress.ok || a.insurance) return
      await ab.page
        .goto(`${c.profiBaseUrl}${parsers.paths.feed}`, { timeout: 30000 })
        .catch(() => {})
      a.insurance = startInsurance({
        eyes,
        ab,
        baseUrl: c.profiBaseUrl,
        parsers,
        feedEveryMs: timing.feedEveryMs,
        chatsEveryMs: timing.chatsEveryMs,
      })
    }
    await start()
    const tick = setInterval(() => {
      void (async () => {
        if (!a.insurance) return start()
        await guard.tick()
        if (guard.online()) await a.watch.tick()
      })().catch(() => {})
    }, timing.tickMs)
    const egressTimer = setInterval(() => {
      void checkEgress(ab.page, c.egressEchoUrl, acc.egressIp).then((e) => {
        a.egress = e
      })
    }, timing.egressEveryMs)
    await a.watch.tick()
    a.stop = async () => {
      clearInterval(tick)
      clearInterval(egressTimer)
      a.insurance?.stop()
      await ab.close()
    }
  }

  const shipper = createShipper({
    db,
    coreEventsUrl: c.coreEventsUrl,
    nodeToken: c.nodeToken,
    pollMs: timing.shipPollMs,
  })
  shipper.start()
  const purge = setInterval(() => void purgeOld(db, new Date()).catch(() => {}), 24 * 3600 * 1000)

  const readTools = createReadTools({ db, accounts: runtimes })
  const host = c.production ? '0.0.0.0' : '127.0.0.1'
  const svc = await serveMcp(() => createProfiMcpServer(readTools), c.port, undefined, host)
  registerScreenRoute(svc.http, { nodeToken: c.nodeToken, browsers })

  return {
    url: svc.url,
    page(id) {
      const a = accounts.get(id)
      if (!a) throw new Error(`account ${id} is not served here`)
      return a.ab.page
    },
    async close() {
      clearInterval(purge)
      for (const a of accounts.values()) await a.stop()
      await shipper.stop()
      await svc.close()
      await closeDb()
    },
  }
}
