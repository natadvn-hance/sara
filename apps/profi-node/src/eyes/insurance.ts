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

export type BoardScroll = {
  /** Pages of the board a pass loads, the one the page opens with included. */
  pages?: number
  /** Every Nth pass reads far more of the board... */
  fullEvery?: number
  /** ...up to this many pages. */
  fullPages?: number
  /** Between two scrolls a person looks at the page (milliseconds, a little random). */
  pauseMs?: number
  /** A pass stops scrolling after this long, so the one tab is not held from the checks and bids behind it. */
  budgetMs?: number
}
// The board answers about 17 orders at a time, by relevance and not by time (346 on 24.10.2026): a new order of low
// relevance sits far down. The first pages every minute, the whole board about every 10 minutes.
const BOARD_SCROLL = { pages: 4, fullEvery: 10, fullPages: 30, pauseMs: 1200, budgetMs: 50000 }

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
  /** How the feed pass scrolls the board for its next pages (see scrollBoard); all of it has a default. */
  board?: BoardScroll
}): Insurance {
  const can = o.canNavigate ?? (() => true)
  const pause = o.chatPauseMs ?? 2000
  const scroll = { ...BOARD_SCROLL, ...o.board }
  let passes = 0
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

  /**
   * Scrolls the open board like a person (the mouse over the list, the wheel, a look between), until the page itself
   * has asked the site for its next part: each answer passes the eyes, so nothing is called by hand. Stops at the
   * page count, the end of the board, the time budget, or when the tab may not move.
   */
  async function scrollBoard(pages: number) {
    const page = o.ab.page
    const t0 = Date.now()
    let loaded = 1
    let stoppedBy: 'pages' | 'end' | 'quiet' | 'time' | 'gate' = 'pages'
    while (loaded < pages) {
      if (!can()) {
        stoppedBy = 'gate'
        break
      }
      if (Date.now() - t0 >= scroll.budgetMs) {
        stoppedBy = 'time'
        break
      }
      const before = o.eyes.board()
      if (!before?.more) {
        stoppedBy = 'end'
        break
      }
      const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]).catch(() => [1280, 720])
      await page.mouse.move((w ?? 1280) / 2, (h ?? 720) / 2).catch(() => {})
      let arrived = false
      for (let step = 0; step < 14 && !arrived && can(); step++) {
        await page.mouse.wheel(0, 450 + Math.random() * 250).catch(() => {})
        await sleep(120 + Math.random() * 120)
        arrived = (o.eyes.board()?.seq ?? 0) > before.seq
      }
      // A slow answer: the page asked, the site is still thinking.
      for (let wait = 0; wait < 30 && !arrived && can(); wait++) {
        await sleep(100)
        arrived = (o.eyes.board()?.seq ?? 0) > before.seq
      }
      if (!arrived) {
        stoppedBy = can() ? 'quiet' : 'gate'
        break
      }
      loaded++
      await sleep(scroll.pauseMs * (0.7 + Math.random() * 0.6))
    }
    // How far the pass got and why it stopped: a note for calibrating the scroll on the live board (no order, no text).
    await keep({
      what: 'board_scroll',
      pages: loaded,
      wanted: pages,
      more: o.eyes.board()?.more ?? null,
      stoppedBy,
      ms: Date.now() - t0,
    })
  }

  async function feedOnce() {
    await serial(async () => {
      if (!can()) return
      if (!(await go(o.parsers.paths.feed))) return
      await readNewOrders()
      passes++
      // Only on the feed page itself (the page links fallback leaves it) and only a board the eyes know.
      if (onFeed && can() && o.eyes.boardWorks() && o.eyes.board()?.more)
        await scrollBoard(passes % scroll.fullEvery === 0 ? scroll.fullPages : scroll.pages)
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
