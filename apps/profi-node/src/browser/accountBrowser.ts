import { type BrowserContext, chromium, type Page } from 'playwright'
import { acquireAccountLock } from './lock'

export type AccountBrowser = { context: BrowserContext; page: Page; close(): Promise<void> }

/** The one live tab of an account: its own profile and, on the server, its own IP through SOCKS (FR-ACC-1). */
export async function openAccountBrowser(o: {
  accountId: string
  profileDir: string
  proxy: string | null
  headless: boolean
  databaseUrl: string
}): Promise<AccountBrowser> {
  const release = await acquireAccountLock(o.databaseUrl, o.accountId)
  let context: BrowserContext
  try {
    context = await chromium.launchPersistentContext(o.profileDir, {
      headless: o.headless,
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      viewport: { width: 1280, height: 800 },
      ...(o.proxy ? { proxy: { server: o.proxy, bypass: '<-loopback>' } } : {}),
      // Without this Chromium sends loopback traffic around the proxy.
      args: o.proxy ? ['--proxy-bypass-list=<-loopback>'] : [],
    })
  } catch (e) {
    await release()
    throw e
  }
  const page = context.pages()[0] ?? (await context.newPage())
  return {
    context,
    page,
    async close() {
      // A clean close flushes cookies to the profile (lesson of v1, 17.09.2026).
      await context.close().catch(() => {})
      await release()
    },
  }
}
