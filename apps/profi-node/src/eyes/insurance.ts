import type { Request, Response } from 'playwright'
import type { AccountBrowser } from '../browser/accountBrowser'
import { anonymousChatUrl, readChatFormMap } from './chatFormMap'
import type { Eyes } from './eyes'
import { readFormMap } from './formMap'
import { BUBBLE, bubbleShapes, pageShape } from './pageShape'
import type { ChatListItem, Parsers } from './parsers'
import { redactSecrets } from './recorder'

export type Insurance = {
  stop(): void
  /** `deep`: reads the whole board, whatever it looks like (after a start or an outage). */
  feedOnce(o?: { deep?: boolean }): Promise<void>
  chatsOnce(onlyUnread?: boolean): Promise<void>
  reconcile(since: string): Promise<void>
  /**
   * Work of its own in the account tab (a bid, an order check), in turn with the checks above; the tab goes back
   * to the feed afterwards. The work itself asks can() before it moves the tab. The answer is given as soon as the
   * work is done, without waiting for the way back; `later` queues errands that still need the page (they run before
   * the tab leaves, after the answer, and their failures are not the caller's). `urgent` is a press Boris made (a
   * bid, a message to a client): it goes before every check waiting for the tab, and a check already running gives
   * way at its next page.
   */
  inTab<T>(
    f: (t: {
      /**
       * `quick`: back as soon as the document answered, without the wait for the page to settle (up to 15 s). A quick
       * look that misses says nothing of the site: right after a press the page may be moving on by itself.
       */
      go(path: string, o?: { quick?: boolean }): Promise<boolean>
      can(): boolean
      later(errand: () => Promise<void>): void
    }) => Promise<T>,
    o?: { urgent?: boolean },
  ): Promise<T>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** How long the chats list's own answer is waited for once its page opened. */
const LIST_ANSWER_MS = 5000
/** A chat check without the list's answer reads its chats blind: no more often than this. */
const BLIND_EVERY_MS = 600000
/** At most this many chats a check opens; the rest go to the next one. */
const NEWS_MAX = 8

export type BoardScroll = {
  /** Pages of the board a pass loads, the one the page opens with included. */
  pages?: number
  /** A pass over the whole board at least this often, whatever the board's count says... */
  deepEveryMs?: number
  /** ...and when the count moved, but not this soon after the last one. */
  deepGapMs?: number
  /** Up to this many pages. */
  fullPages?: number
  /** Between two scrolls a person looks at the page (milliseconds, a little random). */
  pauseMs?: number
  /** A pass stops scrolling after this long, so the one tab is not held from the checks and bids behind it. */
  budgetMs?: number
  /** The same for a pass over the whole board. */
  deepBudgetMs?: number
  /** The ways to make the board load more, in the order tried (the one that worked last time goes first). */
  ways?: BoardWay[]
}

/**
 * How the board is made to load its next part: the wheel over the list, the last card scrolled into view, the
 * scroll box around the cards taken to its bottom, or the «Показать ещё» button. All of them are what a person does;
 * which one the live page answers to was not known when this was written, so the pass tries them in turn.
 */
export type BoardWay = 'wheel' | 'last_card' | 'container' | 'button'
const BOARD_WAYS: BoardWay[] = ['wheel', 'last_card', 'container', 'button']
const MORE_BUTTON =
  /^\s*(показать\s+ещ[её]|ещ[её]\s+заказ|показать\s+больше|загрузить\s+ещ[её]|больше\s+заказов)/i
// The board answers about 17 orders at a time, by relevance score and not by time (346 on 24.10.2026; its cursor reads
// [score, date, order, n]): a new order of low relevance lands far down, where only a pass over the whole board finds
// it. On 01.11.2026 a quarter of the orders were seen over 5 minutes late (95612005: 16 minutes, closed 11 seconds after
// its card). Every answer says how many orders the whole board holds, so the whole board is read as soon as that number
// moves. It is also read on a clock, for a new order and a closed one cancelling out; otherwise the first pages are
// enough. About as many requests to the board as the 4 pages of every pass before this, and a press still goes first.
const BOARD_SCROLL = {
  pages: 2,
  deepEveryMs: 300000,
  /** The number moving this soon after a whole pass waits: a board whose count jitters must not be read all the time. */
  deepGapMs: 60000,
  fullPages: 30,
  pauseMs: 1200,
  budgetMs: 50000,
  /** About 20 pages through the slow proxy: a whole pass must reach the bottom, where the late orders are. */
  deepBudgetMs: 120000,
  ways: BOARD_WAYS,
}

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
  /** How often the chats the event stream named are looked for; each is read at once, in turn with the tab's work. */
  newsEveryMs?: number
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
  const startedAt = Date.now()
  // When the whole board was last read to where it could be, and the board's count that pass answered to.
  let deepAt = Number.NEGATIVE_INFINITY
  let deepTotal: number | null = null
  // The tab does one piece of work at a time, in turn: a press goes before all that waits (on 29.10.2026 a bid waited 2
  // minutes behind the chat check, the feed and another order's page), then a chat the event stream named, then the rest.
  const PRESS = 2
  const NEWS = 1
  const queue: { prio: number; run: () => Promise<void> }[] = []
  let pumping = false
  async function pump() {
    if (pumping) return
    pumping = true
    while (queue.length > 0) {
      let i = 0
      for (let k = 1; k < queue.length; k++)
        if ((queue[k]?.prio ?? 0) > (queue[i]?.prio ?? 0)) i = k
      const [job] = queue.splice(i, 1)
      await job?.run()
    }
    pumping = false
  }
  const serial = <T>(f: () => Promise<T>, prio = 0): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push({ prio, run: () => f().then(resolve, reject) })
      void pump()
    })
  /**
   * A press or a chat the stream named waits for the tab: a running check stops at its next page and leaves the rest to
   * its next turn.
   */
  const pressWaits = () => queue.some((j) => j.prio > 0)
  async function go(path: string, opt?: { quick?: boolean }): Promise<boolean> {
    let ok = false
    // One miss is tried again once the page has settled: the page's own navigation (a form that sent) or one stuck
    // request must not take the site for lost and stop every page for 5 minutes, as after a bid on 29.10.2026. A site
    // that is really gone fails both tries.
    for (let tries = 0; tries < 2 && !ok; tries++) {
      if (tries > 0)
        await o.ab.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
      ok = await goOnce(path, opt?.quick === true)
    }
    // Not awaited: what the guard does next (a reconcile) queues behind this check instead of deadlocking it.
    if (ok || !opt?.quick) void Promise.resolve(o.onNavigate?.(ok)).catch(() => {})
    return ok
  }
  async function goOnce(path: string, quick: boolean): Promise<boolean> {
    let ok = false
    try {
      // A page whose document answered is open. Profi.ru's messenger keeps polling, so its network never goes quiet,
      // and since 29.10.2026 07:14 UTC its pages keep a request open and never fire «load» in 30 s either: waiting
      // for either one counted every working page as a lost connection (the feed went to one page in 5 minutes and
      // no order page was read). The rest of the page gets a short while to settle, whatever it does.
      const res = await o.ab.page.goto(`${o.baseUrl}${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      ok = (res?.status() ?? 0) > 0 && (res?.status() ?? 0) < 500
      if (!quick)
        await o.ab.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    } catch {
      ok = false
    }
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
      if (opened >= 5 || !can() || pressWaits()) break
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

  // The message box of the first chat page that has one, once: the field, the buttons and the attachments control,
  // never a message or a draft. Sending types into this box (src/chat/sendTools.ts), and its first deploy records the
  // real one so the selectors can be checked against it without pressing anything. A page without a box tries again.
  let chatFormKept = false
  async function keepChatFormMap() {
    if (chatFormKept) return
    try {
      const body = await readChatFormMap(o.ab.page)
      if (!body) return
      await o.eyes.onRaw({
        kind: 'dom',
        url: anonymousChatUrl(o.ab.page.url()),
        body,
        receivedAt: new Date().toISOString(),
      })
      chatFormKept = true
    } catch {}
  }

  // The open chat page: its messages, and a record of its bubbles (never their text) for calibration (ST-M1-04).
  async function readChat(id: string) {
    const read = await o.parsers.fromChatDom(o.ab.page, id)
    const messages = await bubbleShapes(o.ab.page).catch(() => [])
    // No bubble found: the page's outline shows what the chat is drawn with now.
    const shape = messages.length === 0 ? await pageShape(o.ab.page).catch(() => []) : undefined
    await keep({ chatId: id, messages, ...(shape ? { shape } : {}) })
    await keepChatFormMap()
    await o.eyes.onChatRead(id, read)
  }

  // Chats the event stream named: read at once by the news job (or by the pass over the feed), 3 at a time.
  async function readTouchedChats() {
    let opened = 0
    for (const id of o.eyes.chatsTouched()) {
      if (opened >= 3 || !can() || pressWaits()) return
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

  let goodWay: BoardWay | null = null
  let probed = false

  const arrived = (seq: number) => (o.eyes.board()?.seq ?? 0) > seq
  async function answered(seq: number, ms: number): Promise<boolean> {
    for (let t = 0; t < ms && can() && !arrived(seq); t += 100) await sleep(100)
    return arrived(seq)
  }

  /** One way, then a wait for the page's own answer (a new board answer through the eyes). */
  async function tryWay(way: BoardWay, seq: number): Promise<boolean> {
    const page = o.ab.page
    if (way === 'wheel') {
      const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]).catch(() => [1280, 720])
      await page.mouse.move((w ?? 1280) / 2, (h ?? 720) / 2).catch(() => {})
      for (let step = 0; step < 3 && can(); step++) {
        await page.mouse.wheel(0, 450 + Math.random() * 250).catch(() => {})
        await sleep(120 + Math.random() * 120)
        if (arrived(seq)) return true
      }
      return answered(seq, 1800)
    }
    if (way === 'button') {
      await page
        .locator('button, a, [role="button"]')
        .filter({ hasText: MORE_BUTTON })
        .first()
        .click({ timeout: 1500 })
        .catch(() => {})
      return answered(seq, 1500)
    }
    // In the page: no named inner functions (tsx wraps those in a helper the page does not have).
    await page
      .evaluate(
        ({ sel, how }) => {
          const cards = sel ? Array.from(document.querySelectorAll(sel)) : []
          const last = cards.length > 0 ? cards[cards.length - 1] : undefined
          if (how === 'last_card') {
            // To the top of the view: the list then runs to its end, past whatever the card holds below its link.
            if (last) last.scrollIntoView({ block: 'start' })
            return
          }
          let el = last ? last.parentElement : null
          while (el && el !== document.documentElement) {
            if (
              el.scrollHeight > el.clientHeight + 4 &&
              /(auto|scroll)/.test(getComputedStyle(el).overflowY)
            ) {
              el.scrollTop = el.scrollHeight
              return
            }
            el = el.parentElement
          }
          const root = document.scrollingElement
          if (root) root.scrollTop = root.scrollHeight
        },
        { sel: o.parsers.boardCards ?? '', how: way },
      )
      .catch(() => {})
    return answered(seq, 1500)
  }

  /** The next part of the board: the way that worked before first, then the others. Null: none of them did. */
  async function loadMore(seq: number): Promise<{ way: BoardWay | null; tried: BoardWay[] }> {
    const ways = scroll.ways
    const order =
      goodWay && ways.includes(goodWay) ? [goodWay, ...ways.filter((w) => w !== goodWay)] : ways
    const tried: BoardWay[] = []
    for (const way of order) {
      if (!can()) break
      tried.push(way)
      if (await tryWay(way, seq)) {
        goodWay = way
        return { way, tried }
      }
    }
    goodWay = null
    return { way: null, tried }
  }

  /**
   * What the board page is made of, without any order's words: how many cards, the boxes around the last card that
   * scroll (tag, classes, sizes), the window's sizes, buttons that read like «show more». For calibrating the scroll.
   */
  function probeBoard() {
    return o.ab.page
      .evaluate((sel) => {
        const cards = sel ? Array.from(document.querySelectorAll(sel)) : []
        const last = cards.length > 0 ? cards[cards.length - 1] : undefined
        const boxes = []
        let el = last ? last.parentElement : null
        while (el && el !== document.documentElement) {
          if (
            el.scrollHeight > el.clientHeight + 4 &&
            /(auto|scroll)/.test(getComputedStyle(el).overflowY)
          ) {
            boxes.push({
              tag: el.tagName.toLowerCase(),
              classes: Array.from(el.classList).slice(0, 6),
              scrollTop: Math.round(el.scrollTop),
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
            })
          }
          el = el.parentElement
        }
        const rect = last ? last.getBoundingClientRect() : null
        const root = document.scrollingElement
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'))
          .filter(
            (b) =>
              /(показать|ещ[её]|больше|загрузить)/i.test((b.textContent ?? '').trim()) &&
              (b.textContent ?? '').trim().length < 30,
          )
          .slice(0, 3)
          .map((b) => ({
            tag: b.tagName.toLowerCase(),
            classes: Array.from(b.classList).slice(0, 6),
            text: (b.textContent ?? '').trim(),
          }))
        return {
          cards: cards.length,
          lastCard:
            last && rect
              ? {
                  tag: last.tagName.toLowerCase(),
                  classes: Array.from(last.classList).slice(0, 6),
                  top: Math.round(rect.top),
                  bottom: Math.round(rect.bottom),
                }
              : null,
          boxes: boxes.slice(0, 3),
          window: {
            scrollHeight: root ? root.scrollHeight : 0,
            innerHeight,
            scrollY: Math.round(scrollY),
          },
          buttons,
        }
      }, o.parsers.boardCards ?? '')
      .catch(() => null)
  }

  /**
   * Scrolls the open board like a person until the page itself has asked the site for its next part: each answer
   * passes the eyes, so nothing is called by hand. Stops at the page count, the end of the board, the time budget, or
   * when the tab may not move or no way makes the page load more.
   */
  async function scrollBoard(pages: number, budgetMs: number) {
    const t0 = Date.now()
    let loaded = 1
    let stoppedBy: 'pages' | 'end' | 'quiet' | 'time' | 'gate' | 'press' = 'pages'
    const worked: BoardWay[] = []
    let tried: BoardWay[] = []
    while (loaded < pages) {
      if (!can()) {
        stoppedBy = 'gate'
        break
      }
      if (Date.now() - t0 >= budgetMs) {
        stoppedBy = 'time'
        break
      }
      if (pressWaits()) {
        stoppedBy = 'press'
        break
      }
      const before = o.eyes.board()
      if (!before?.more) {
        stoppedBy = 'end'
        break
      }
      const r = await loadMore(before.seq)
      tried = r.tried
      if (!r.way) {
        stoppedBy = can() ? 'quiet' : 'gate'
        break
      }
      worked.push(r.way)
      loaded++
      await sleep(scroll.pauseMs * (0.7 + Math.random() * 0.6))
    }
    // How far the pass got, why it stopped and by which way: a note for calibrating the scroll on the live board.
    // When nothing loaded (and once on the first pass) it holds the shape of the page too, never an order's words.
    const probe = stoppedBy === 'quiet' || !probed ? await probeBoard() : undefined
    probed = true
    await keep({
      what: 'board_scroll',
      pages: loaded,
      wanted: pages,
      more: o.eyes.board()?.more ?? null,
      stoppedBy,
      ms: Date.now() - t0,
      worked,
      tried,
      ...(probe && { probe }),
    })
    return stoppedBy
  }

  /** The whole board when asked, when the board's count moved or when its time came; else the first pages. */
  async function readBoard(asked: boolean) {
    const now = Date.now()
    const total = o.eyes.board()?.total ?? null
    const moved =
      total !== null &&
      deepTotal !== null &&
      total !== deepTotal &&
      now - deepAt >= scroll.deepGapMs
    if (deepTotal === null) deepTotal = total
    const due = now - Math.max(deepAt, startedAt) >= scroll.deepEveryMs
    if (!asked && !moved && !due) {
      await scrollBoard(scroll.pages, scroll.budgetMs)
      return
    }
    const stoppedBy = await scrollBoard(scroll.fullPages, scroll.deepBudgetMs)
    // Given way to a press, or the tab stopped: the next pass reads it again. Otherwise this is as far as it goes.
    if (stoppedBy === 'press' || stoppedBy === 'gate') return
    deepAt = Date.now()
    deepTotal = total
  }

  async function feedOnce(opt?: { deep?: boolean }) {
    await serial(async () => {
      if (!can()) return
      o.eyes.boardPassStart()
      if (!(await go(o.parsers.paths.feed))) return
      await readNewOrders()
      // Only on the feed page itself (the page links fallback leaves it) and only a board the eyes know.
      if (onFeed && can() && !pressWaits() && o.eyes.boardWorks() && o.eyes.board()?.more)
        await readBoard(opt?.deep === true)
      // Before the chats: the way back to the feed brings its first page again, which is not this pass's.
      await o.eyes.boardPassEnd()
      await readTouchedChats()
      if (o.parsers.paths.feed && can() && !pressWaits()) await maybeBackToFeed()
      await o.eyes.onParsed(
        { recognized: false, signals: await o.parsers.fromHeaderDom(o.ab.page) },
        'dom',
      )
    })
  }

  // The chats list of the real site draws neither links nor marks (its answer has them): its addresses and the outline
  // of its elements (never its text) are kept so the list reader can be calibrated on them (ST-M1-04).
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

  /**
   * Opens the chats list. Its chats come from the list's own answer when the parsers read one (the live list draws
   * neither links nor marks; its answer rboMessengersByFilter has each chat's unread count and last time), else from
   * the page; `marks` says the answer came. Null when the page did not open.
   */
  async function openList(): Promise<{ items: ChatListItem[]; marks: boolean } | null> {
    const page = o.ab.page
    const parse = o.parsers.chatsFromAnswer
    const byId = new Map<string, ChatListItem>()
    let answered = false
    let came: () => void = () => {}
    const first = new Promise<void>((r) => {
      came = r
    })
    const onResponse = async (res: Response) => {
      if (!parse || !['fetch', 'xhr'].includes(res.request().resourceType())) return
      try {
        const items = parse(res.url(), await res.json())
        if (!items) return
        for (const c of items) byId.set(c.chatId, c)
        answered = true
        came()
      } catch {}
    }
    page.on('response', onResponse)
    try {
      if (!(await go(chatsPath ?? o.parsers.paths.chats))) return null
      onFeed = false
      if (parse && !answered) await Promise.race([first, sleep(LIST_ANSWER_MS)])
      if (answered) return { items: [...byId.values()], marks: true }
      return { items: await o.parsers.fromChatsDom(page), marks: false }
    } finally {
      page.off('response', onResponse)
    }
  }

  // The real list showed not one chat link on 24.10.2026 and gave no answer to read: the chats Sara already knows are
  // read in its place, so a message the event stream missed is still found (FR-CONV-1). Their news on the site is
  // unknown, so each counts as unread with no known time.
  async function listOrKnown(list: { items: ChatListItem[]; marks: boolean }) {
    if (list.marks || list.items.length > 0) return list.items
    return (await o.eyes.knownChats()).map((chatId) => ({ chatId, unread: 1, lastAt: null }))
  }

  async function chats(pick: (c: ChatListItem) => boolean) {
    await serial(async () => {
      if (!can()) return
      const list = await openList()
      if (!list) return
      await keepList()
      for (const c of (await listOrKnown(list)).filter(pick)) {
        if (!can()) return
        // A press goes first; the check starts again behind it, so no chat waits for the next 10 minutes.
        if (pressWaits()) {
          void chats(pick).catch(() => {})
          return
        }
        await sleep(pause)
        if (!(await go(o.parsers.paths.chat(c.chatId)))) return
        await readChat(c.chatId)
      }
      // Back to the feed, where the event stream lives.
      if (can()) await go(o.parsers.paths.feed)
    })
  }

  // The chat check every 2 minutes (Boris, 31.10.2026: «чаще просматривать страницы»): the list page, and only the
  // chats it marks unread or whose last message is newer than the newest one the node holds, each such news once.
  // Without the list's answer every chat would be read blind (up to 10 pages): that only every 10 minutes, as before.
  const handled = new Map<string, string | null>()
  let blindAt = Number.NEGATIVE_INFINITY
  async function newsCheck() {
    if (Date.now() - blindAt < BLIND_EVERY_MS) return
    await serial(async () => {
      if (!can()) return
      const list = await openList()
      if (!list) return
      if (!list.marks) {
        blindAt = Date.now()
        await keepList()
      }
      const named = new Set(o.eyes.chatsTouched())
      const held = list.marks
        ? await o.eyes.lastStored(list.items.map((c) => c.chatId))
        : new Map<string, number>()
      const news = (await listOrKnown(list)).filter((c) => {
        // A chat the stream named is read by the news job right away.
        if (named.has(c.chatId)) return false
        if (!list.marks) return c.unread > 0
        if (handled.has(c.chatId) && handled.get(c.chatId) === c.lastAt) return false
        const mine = held.get(c.chatId)
        const at = c.lastAt === null ? Number.NaN : Date.parse(c.lastAt)
        return c.unread > 0 || (mine !== undefined && at > mine)
      })
      let opened = 0
      for (const c of news.slice(0, NEWS_MAX)) {
        if (!can() || pressWaits()) break
        await sleep(pause)
        if (!(await go(o.parsers.paths.chat(c.chatId)))) break
        opened++
        await readChat(c.chatId)
        handled.delete(c.chatId)
        if (handled.size >= 500) handled.delete(handled.keys().next().value ?? '')
        handled.set(c.chatId, c.lastAt)
      }
      // How the check went, without a chat's words: what the list gave and how many pages it cost.
      await keep({
        what: 'chat_check',
        from: list.marks ? 'answer' : 'page',
        chats: list.items.length,
        news: news.length,
        opened,
      })
    })
  }

  // A chat the event stream named is read at once, not at the next pass over the feed: the stream names only the chat,
  // its words are on the chat page (FR-CONV-1).
  async function readNews() {
    if (o.eyes.chatsTouched().length === 0) return
    await serial(async () => {
      await readTouchedChats()
      if (can() && !pressWaits()) await maybeBackToFeed()
    }, NEWS)
  }

  // A check still waiting or running is not queued again: a whole-board pass (up to 50 s) would otherwise stack the
  // 30-second passes behind it and the tab would never rest on the feed.
  const unlessBusy = (f: () => Promise<void>) => {
    let busy = false
    return () => {
      if (busy) return
      busy = true
      void f()
        .catch(() => {})
        .finally(() => {
          busy = false
        })
    }
  }
  // How the page asks for the board, once a run: whether it can be sorted by date or read by itself is judged on this.
  let boardAsked = false
  const onRequest = (q: Request) => {
    const body = q.postData()
    if (boardAsked || !o.parsers.isBoardRequest?.(q.url(), body)) return
    boardAsked = true
    let asked: unknown = null
    try {
      asked = redactSecrets(JSON.parse(body ?? 'null'))
    } catch {}
    void keep({ what: 'board_request', url: q.url(), body: asked })
  }
  o.ab.page.on('request', onRequest)
  const timers = [
    setInterval(
      unlessBusy(() => feedOnce()),
      o.feedEveryMs ?? 30000,
    ),
    setInterval(unlessBusy(newsCheck), o.chatsEveryMs ?? 120000),
    setInterval(unlessBusy(readNews), o.newsEveryMs ?? 1000),
  ]

  return {
    stop: () => {
      for (const t of timers) clearInterval(t)
      o.ab.page.off('request', onRequest)
    },
    feedOnce,
    chatsOnce: (onlyUnread = true) => chats((c) => !onlyUnread || c.unread > 0),
    inTab<T>(
      f: (t: {
        go(path: string, o?: { quick?: boolean }): Promise<boolean>
        can(): boolean
        later(errand: () => Promise<void>): void
      }) => Promise<T>,
      opt?: { urgent?: boolean },
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        void serial(
          async () => {
            const errands: (() => Promise<void>)[] = []
            try {
              resolve(
                await f({
                  // Asked again on every page: the IP may turn wrong or a viewer come in the middle of the work.
                  go: async (path, goOpt) => {
                    if (!can()) return false
                    onFeed = false
                    return go(path, goOpt)
                  },
                  can,
                  later: (errand) => void errands.push(errand),
                }),
              )
            } catch (e) {
              reject(e)
            }
            // Errands (the form map, the calibration) give way to a press too.
            for (const errand of errands) if (!pressWaits()) await errand().catch(() => {})
            if (can() && !pressWaits()) await maybeBackToFeed()
          },
          opt?.urgent === true ? PRESS : 0,
        ).catch(() => {})
      })
    },
    // After a logout or an outage: the feed and the chats with messages since then, one by one (F8).
    async reconcile(since) {
      await feedOnce({ deep: true })
      // A chat without a known last time is read too: missing a message is worse than one more page.
      await chats((c) => c.lastAt === null || c.lastAt >= since)
    },
  }
}
