import type { AccountBrowser } from '../browser/accountBrowser'
import type { Eyes } from './eyes'
import type { Parsers } from './parsers'

export type Insurance = {
  stop(): void
  feedOnce(): Promise<void>
  chatsOnce(onlyUnread?: boolean): Promise<void>
  reconcile(since: string): Promise<void>
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
}): Insurance {
  const can = o.canNavigate ?? (() => true)
  const pause = o.chatPauseMs ?? 2000
  let busy: Promise<void> = Promise.resolve()
  const serial = (f: () => Promise<void>) => {
    busy = busy.then(f, f)
    return busy
  }
  async function go(path: string): Promise<boolean> {
    let ok = false
    try {
      const res = await o.ab.page.goto(`${o.baseUrl}${path}`, {
        waitUntil: 'networkidle',
        timeout: 30000,
      })
      ok = (res?.status() ?? 0) > 0 && (res?.status() ?? 0) < 500
    } catch {
      ok = false
    }
    // Not awaited: what the guard does next (a reconcile) queues behind this check instead of deadlocking it.
    void Promise.resolve(o.onNavigate?.(ok)).catch(() => {})
    return ok
  }

  let chatsPath: string | null = null
  let onFeed = true

  // Eyes 3 (old Sara's way): order numbers from the feed page and the board answer, then each new order's own
  // page, once: only the page shows the fee for a bid.
  async function readNewOrders() {
    onFeed = true
    if (!o.parsers.fromFeedDom) return
    const feed = await o.parsers.fromFeedDom(o.ab.page)
    await o.eyes.onParsed({ recognized: feed.recognized, what: 'feed', signals: [] }, 'dom')
    chatsPath = (await o.parsers.chatsUrl?.(o.ab.page)) ?? chatsPath
    const fromOrderDom = o.parsers.fromOrderDom
    const orderPath = o.parsers.paths.order
    if (!fromOrderDom || !orderPath) {
      for (const id of o.eyes.ordersWantingPage()) await o.eyes.settleOrder(id)
      return
    }
    const ids = [...new Set([...feed.refs.map((r) => r.orderId), ...o.eyes.ordersWantingPage()])]
    let opened = 0
    for (const id of ids) {
      if (opened >= 5 || !can()) break
      if (await o.eyes.knowsOrder(id)) continue
      await sleep(pause)
      if (!(await go(orderPath(id)))) return
      onFeed = false
      opened++
      const page = await fromOrderDom(o.ab.page, id)
      await o.eyes.onParsed(page, 'dom')
      // An expired or changed page still lets a board order through, without its fee.
      if (!page.signals.some((s) => s.t === 'order')) await o.eyes.settleOrder(id)
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
      if (o.parsers.paths.feed && can()) await maybeBackToFeed()
      await o.eyes.onParsed(
        { recognized: false, signals: await o.parsers.fromHeaderDom(o.ab.page) },
        'dom',
      )
    })
  }

  async function chats(pick: (c: { unread: number; lastAt: string | null }) => boolean) {
    await serial(async () => {
      if (!can() || !(await go(chatsPath ?? o.parsers.paths.chats))) return
      const list = await o.parsers.fromChatsDom(o.ab.page)
      for (const c of list.filter(pick)) {
        if (!can()) return
        await sleep(pause)
        if (!(await go(o.parsers.paths.chat(c.chatId)))) return
        await o.eyes.onParsed(await o.parsers.fromChatDom(o.ab.page, c.chatId), 'dom')
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
    // After a logout or an outage: the feed and the chats with messages since then, one by one (F8).
    async reconcile(since) {
      await feedOnce()
      // A chat without a known last time is read too: missing a message is worse than one more page.
      await chats((c) => c.lastAt === null || c.lastAt >= since)
    },
  }
}
