import type { AccountBrowser } from '../browser/accountBrowser'
import type { Eyes } from './eyes'
import { readFormMap } from './formMap'
import { BUBBLE, bubbleShapes, pageShape } from './pageShape'
import type { Parsers } from './parsers'

export type Insurance = {
  stop(): void
  feedOnce(): Promise<void>
  chatsOnce(onlyUnread?: boolean): Promise<void>
  reconcile(since: string): Promise<void>
  /**
   * Work of its own in the account tab (a bid, an order check), in turn with the checks above; the tab goes back
   * to the feed afterwards. The work itself asks can() before it moves the tab. The answer is given as soon as the
   * work is done, without waiting for the way back; `later` queues errands that still need the page (they run before
   * the tab leaves, after the answer, and their failures are not the caller's).
   */
  inTab<T>(
    f: (t: {
      go(path: string): Promise<boolean>
      can(): boolean
      later(errand: () => Promise<void>): void
    }) => Promise<T>,
  ): Promise<T>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The minute check (FR-LEAD-1) and the 10-minute chat check (FR-CONV-1): open the feed and unread chats in the
 * same tab, so the site's own answers pass the eyes again. It never touches the tab when canNavigate says no:
 * a dead session (Boris is logging in on the live screen), no connection, a wrong IP, or someone watching the
 * live screen.
 */
export function startInsurance(o: {
  eyes: Eyes
  ab: AccountBrowser
  baseUrl: string
  parsers: Parsers
  feedEveryMs?: number
  chatsEveryMs?: number
  chatPauseMs?: number
  canNavigate?: () => boolean
  onNavigate?: (ok: boolean) => Promise<void> | void
  /**
   * On each order page this check opened, after the order went on and while the tab is still there (the form
   * calibration, src/bid). It gets the tab's gate to ask again right before it presses anything.
   */
  afterOrderPage?: (orderId: string, may: () => boolean) => Promise<void>
}): Insurance {
  const can = o.canNavigate ?? (() => true)
  const pause = o.chatPauseMs ?? 2000
  let busy: Promise<unknown> = Promise.resolve()
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = busy.then(f, f)
    busy = run.catch(() => {})
    return run
  }
  async function go(path: string): Promise<boolean> {
    let ok = false
    try {
      // A page that answered is open. Profi.ru's messenger keeps polling, so its network never goes quiet:
      // waiting for that as well would count a working page as a lost connection (5 minutes of nothing).
      const res = await o.ab.page.goto(`${o.baseUrl}${path}`, { waitUntil: 'load', timeout: 30000 })
      ok = (res?.status() ?? 0) > 0 && (res?.status() ?? 0) < 500
      await o.ab.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    } catch {
      ok = false
    }
    // Not awaited: what the guard does next (a reconcile) queues behind this check instead of deadlocking it.
    void Promise.resolve(o.onNavigate?.(ok)).catch(() => {})
    return ok
  }

  let chatsPath: string | null = null
  let onFeed = true

  // Eyes 3, the fallback while the board answer is silent (old Sara's way): the feed page links, then each new
  // order's own page, once. A board order is never opened here: it goes to the core as the board showed it, and the
  // core reads its page only if the order passes the Scorer (get_order).
  async function readNewOrders() {
    onFeed = true
    if (!o.parsers.fromFeedDom) return
    const feed = await o.parsers.fromFeedDom(o.ab.page)
    await o.eyes.onParsed({ recognized: feed.recognized, what: 'feed', signals: [] }, 'dom')
    chatsPath = (await o.parsers.chatsUrl?.(o.ab.page)) ?? chatsPath
    const fromOrderDom = o.parsers.fromOrderDom
    const orderPath = o.parsers.paths.order
    if (!fromOrderDom || !orderPath) return
    // The real feed page links hundreds of old orders too: while the board answers, none of them is opened.
    const ids = o.eyes.boardWorks() ? [] : [...new Set(feed.refs.map((r) => r.orderId))]
    let opened = 0
    for (const id of ids) {
      if (opened >= 5 || !can()) break
      if (await o.eyes.knowsOrder(id)) continue
      await sleep(pause)
      if (!(await go(orderPath(id)))) return
      onFeed = false
      opened++
      const page = await fromOrderDom(o.ab.page, id)
      await keepFormMap()
      await o.eyes.onParsed(page, 'dom')
      if (o.afterOrderPage && can()) await o.afterOrderPage(id, can).catch(() => {})
    }
  }

  async function keep(body: unknown) {
    await o.eyes
      .onRaw({ kind: 'dom', url: o.ab.page.url(), body, receivedAt: new Date().toISOString() })
      .catch(() => {})
  }

  // The bid form changed since September: a map of it on every order page (never a click) calibrates the bid.
  async function keepFormMap() {
    const body = await readFormMap(o.ab.page)
    if (body) await keep(body)
  }

  // The open chat page: its messages, and a record of its bubbles (never their text) for calibration (ST-M1-04).
  async function readChat(id: string) {
    const read = await o.parsers.fromChatDom(o.ab.page, id)
    const messages = await bubbleShapes(o.ab.page).catch(() => [])
    // No bubble found: the page's outline shows what the chat is drawn with now.
    const shape = messages.length === 0 ? await pageShape(o.ab.page).catch(() => []) : undefined
    await keep({ chatId: id, messages, ...(shape ? { shape } : {}) })
    await o.eyes.onChatRead(id, read)
  }

  // Chats the event stream named: read within the minute, at most 3 a pass, the rest on the next one.
  async function readTouchedChats() {
    let opened = 0
    for (const id of o.eyes.chatsTouched()) {
      if (opened >= 3 || !can()) return
      await sleep(pause)
      if (!(await go(o.parsers.paths.chat(id)))) return
      onFeed = false
      opened++
      await readChat(id)
    }
  }

  async function maybeBackToFeed() {
    if (onFeed) return
    await go(o.parsers.paths.feed)
    onFeed = true
  }

  async function feedOnce() {
    await serial(async () => {
      if (!can()) return
      if (!(await go(o.parsers.paths.feed))) return
      await readNewOrders()
      await readTouchedChats()
      if (o.parsers.paths.feed && can()) await maybeBackToFeed()
      await o.eyes.onParsed(
        { recognized: false, signals: await o.parsers.fromHeaderDom(o.ab.page) },
        'dom',
      )
    })
  }

  // The chats list of the real site is drawn without a JSON answer: its addresses and the outline of its elements
  // (never its text) are kept so the list reader can be calibrated on them (ST-M1-04).
  async function keepList() {
    const links = await o.ab.page
      .evaluate(
        (bubble) => ({
          links: [
            ...new Set(
              [...document.querySelectorAll('a[href]')]
                .map((a) => new URL((a as HTMLAnchorElement).href, location.href))
                .filter((u) => u.origin === location.origin)
                .map((u) => `${u.pathname}${u.search}`),
            ),
          ].slice(0, 300),
          messages: document.querySelectorAll(bubble).length,
        }),
        BUBBLE,
      )
      .catch(() => null)
    if (links) await keep({ ...links, shape: await pageShape(o.ab.page).catch(() => []) })
  }

  async function chats(pick: (c: { unread: number; lastAt: string | null }) => boolean) {
    await serial(async () => {
      if (!can() || !(await go(chatsPath ?? o.parsers.paths.chats))) return
      await keepList()
      const shown = await o.parsers.fromChatsDom(o.ab.page)
      // The real list showed not one chat link on 24.10.2026: the chats Sara already knows are read in its place, so
      // a message the event stream missed is still found within 10 minutes (FR-CONV-1). Their news on the site is
      // unknown, so each counts as unread with no known time.
      const list =
        shown.length > 0
          ? shown
          : (await o.eyes.knownChats()).map((chatId) => ({ chatId, unread: 1, lastAt: null }))
      for (const c of list.filter(pick)) {
        if (!can()) return
        await sleep(pause)
        if (!(await go(o.parsers.paths.chat(c.chatId)))) return
        await readChat(c.chatId)
      }
      // Back to the feed, where the event stream lives.
      if (can()) await go(o.parsers.paths.feed)
    })
  }

  const timers = [
    setInterval(() => void feedOnce().catch(() => {}), o.feedEveryMs ?? 60000),
    setInterval(() => void chats((c) => c.unread > 0).catch(() => {}), o.chatsEveryMs ?? 600000),
  ]

  return {
    stop: () => {
      for (const t of timers) clearInterval(t)
    },
    feedOnce,
    chatsOnce: (onlyUnread = true) => chats((c) => !onlyUnread || c.unread > 0),
    inTab<T>(
      f: (t: {
        go(path: string): Promise<boolean>
        can(): boolean
        later(errand: () => Promise<void>): void
      }) => Promise<T>,
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        void serial(async () => {
          const errands: (() => Promise<void>)[] = []
          try {
            resolve(
              await f({
                // Asked again on every page: the IP may turn wrong or a viewer come in the middle of the work.
                go: async (path) => {
                  if (!can()) return false
                  onFeed = false
                  return go(path)
                },
                can,
                later: (errand) => void errands.push(errand),
              }),
            )
          } catch (e) {
            reject(e)
          }
          for (const errand of errands) await errand().catch(() => {})
          if (can()) await maybeBackToFeed()
        }).catch(() => {})
      })
    },
    // After a logout or an outage: the feed and the chats with messages since then, one by one (F8).
    async reconcile(since) {
      await feedOnce()
      // A chat without a known last time is read too: missing a message is worse than one more page.
      await chats((c) => c.lastAt === null || c.lastAt >= since)
    },
  }
}
