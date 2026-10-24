import { join } from 'node:path'
import type { SessionHealthOutput } from '@sara/shared'
import type { Page } from 'playwright'
import { type AccountBrowser, openAccountBrowser } from './browser/accountBrowser'
import { checkEgress } from './browser/egress'
import type { NodeConfig } from './config'
import { createNodeDb } from './db/client'
import { migrateNode } from './db/migrate'
import { createEyes } from './eyes/eyes'
import { type Insurance, startInsurance } from './eyes/insurance'
import { activeParsers } from './eyes/profiParsers'
import { attachRecorder } from './eyes/recorder'
import { serveMcp } from './mcp/http'
import { createProfiMcpServer } from './mcp/server'
import { registerScreenRoute } from './screen/screenRoute'
import { createShipper } from './ship/shipper'
import { purgeOld } from './store/purge'
import { type AccountRuntime, createReadTools } from './tools/readTools'
import { createConnectionGuard } from './watch/connectionGuard'
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

export type ProfiService = {
  url: string
  page(accountId: string): Page
  health(accountId: string): Promise<SessionHealthOutput>
  close(): Promise<void>
}

export type ServiceOptions = Partial<ServiceTimings> & {
  /** The browser of an account died or hangs: by default the process exits so Docker restarts it cleanly. */
  onBrowserGone?: (accountId: string) => void
}

type Account = {
  ab: AccountBrowser
  watch: SessionWatch
  insurance: Insurance | null
  egress: { ok: boolean; seen: string | null }
  viewers: { n: number }
  stop(): Promise<void>
}

/** The live Profi-MCP: per account a tab with its own IP, eyes, session watch and connection guard. */
export async function startProfiService(
  c: NodeConfig,
  t: ServiceOptions = {},
): Promise<ProfiService> {
  const timing = { ...DEFAULT_TIMINGS, ...t }
  const o = {
    onBrowserGone:
      t.onBrowserGone ??
      ((id: string) => {
        console.error(`Браузер аккаунта ${id} перестал отвечать, перезапускаюсь`)
        process.exit(1)
      }),
  }
  await migrateNode(c.databaseUrl)
  const { db, close: closeDb } = createNodeDb(c.databaseUrl)
  const parsers = activeParsers
  const baseHost = new URL(c.profiBaseUrl).host
  const accounts = new Map<string, Account>()
  let closing = false
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
    ab.context.on('close', () => {
      if (!closing) o.onBrowserGone(acc.id)
    })
    const eyes = createEyes({ accountId: acc.id, db, parsers })
    const accountIdOf = acc.id
    await attachRecorder(ab, {
      accountId: acc.id,
      rtpHost: c.rtpHost,
      profiHosts: [baseHost],
      // Not while logged out (login answers carry tokens) or on a wrong IP (ADR-022, FR-ACC-1).
      shouldRecord: () => {
        const acc = accounts.get(accountIdOf)
        return (
          !!acc && acc.egress.ok && acc.watch.state() !== 'dead' && acc.watch.state() !== 'banned'
        )
      },
      onRaw: (r) => eyes.onRaw(r),
    })
    const viewers = { n: 0 }
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
        onStuck: () => o.onBrowserGone(acc.id),
      }),
      viewers,
      async stop() {},
    }
    accounts.set(acc.id, a)
    runtimes.set(acc.id, {
      watch: a.watch,
      eyes,
      egressIp: () => a.egress.seen,
      egressOk: () => a.egress.ok,
      silenceMs: 600000,
    })

    const guard = createConnectionGuard({
      db,
      accountId: acc.id,
      onBack: async (since) => {
        await a.insurance?.reconcile(since)
      },
    })

    // One gate for every page load of the account tab: own IP, a session that is not dead (Boris may be logging
    // in on the live screen), nobody watching the live screen, and a reachable site (FR-ACC-1, FR-ACC-6, ADR-021).
    const canNavigate = () =>
      a.egress.ok &&
      a.watch.state() !== 'dead' &&
      a.watch.state() !== 'banned' &&
      viewers.n === 0 &&
      guard.mayNavigate()

    // The site is opened only from the account's own IP; until then the tab stays away from it.
    const start = async () => {
      a.egress = await checkEgress(ab.page, c.egressEchoUrl, acc.egressIp)
      if (!a.egress.ok || a.insurance) return
      a.insurance = startInsurance({
        eyes,
        ab,
        baseUrl: c.profiBaseUrl,
        parsers,
        feedEveryMs: timing.feedEveryMs,
        chatsEveryMs: timing.chatsEveryMs,
        canNavigate,
        onNavigate: (ok) => guard.report(ok),
      })
      await a.insurance.feedOnce()
      await a.watch.tick()
    }
    await start()
    const tick = setInterval(() => {
      void (async () => {
        if (!a.insurance) return start()
        await guard.tick()
        if (a.egress.ok) await eyes.checkSilence(Date.now(), canNavigate())
        if (guard.online()) await a.watch.tick()
      })().catch(() => {})
    }, timing.tickMs)
    const egressTimer = setInterval(() => {
      void checkEgress(ab.page, c.egressEchoUrl, acc.egressIp)
        .then(async (e) => {
          a.egress = e
          // A wrong IP stops the account at once: away from the site until the IP is right again.
          if (!e.ok) await ab.page.goto('about:blank').catch(() => {})
        })
        .catch(() => {})
    }, timing.egressEveryMs)
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
  registerScreenRoute(svc.http, {
    nodeToken: c.nodeToken,
    browsers,
    onViewers: (id, n) => {
      const a = accounts.get(id)
      if (a) a.viewers.n = n
    },
    allowInput: (id) => accounts.get(id)?.egress.ok ?? false,
  })

  return {
    url: svc.url,
    page(id) {
      const a = accounts.get(id)
      if (!a) throw new Error(`account ${id} is not served here`)
      return a.ab.page
    },
    health: (id) => readTools.sessionHealth({ account_id: id }),
    async close() {
      closing = true
      clearInterval(purge)
      for (const a of accounts.values()) await a.stop()
      await shipper.stop()
      await svc.close()
      await closeDb()
    },
  }
}
