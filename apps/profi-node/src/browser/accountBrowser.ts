import { type BrowserContext, chromium, type Page } from 'playwright'
import { acquireAccountLock } from './lock'

const NAME_HELPER = 'globalThis.__name ??= (f) => f'

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
  // On the server the node runs under tsx, which wraps every inner function in __name(...): a page has no such
  // helper, so any page read with an inner function would fail there. Every document of the tab gets one.
  await context.addInitScript(NAME_HELPER)
  // A page that asks before it is left (a form or a message box with text in it) would keep the tab where it is:
  // Playwright dismisses that question by default, so the next page of the node hung and counted as a lost connection
  // (29.10.2026, 5 minutes without a page right after a bid). The node always means to leave.
  const leave = (p: Page) =>
    p.on(
      'dialog',
      (d) => void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}),
    )
  context.on('page', leave)
  for (const p of context.pages()) leave(p)
  const page = context.pages()[0] ?? (await context.newPage())
  // The tab that is already open got its document before the init script.
  await Promise.all(context.pages().map((p) => p.evaluate(NAME_HELPER).catch(() => {})))
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
