import type { AccountBrowser } from '../browser/accountBrowser'
import type { Eyes } from './eyes'
import type { Parsers } from './parsers'

export type Insurance = {
  stop(): void
  feedOnce(): Promise<void>
  chatsOnce(onlyUnread?: boolean): Promise<void>
  reconcile(since: string): Promise<void>
}

/**
 * The minute check (FR-LEAD-1) and the 10-minute chat check (FR-CONV-1): open the feed and unread chats in the
 * same tab, so the site's own answers pass the eyes again. Catches whatever the event stream missed.
 */
export function startInsurance(o: {
  eyes: Eyes
  ab: AccountBrowser
  baseUrl: string
  parsers: Parsers
  feedEveryMs?: number
  chatsEveryMs?: number
}): Insurance {
  let busy: Promise<void> = Promise.resolve()
  const serial = (f: () => Promise<void>) => {
    busy = busy.then(f, f)
    return busy
  }
  const go = (path: string) =>
    o.ab.page.goto(`${o.baseUrl}${path}`, { waitUntil: 'networkidle', timeout: 30000 })

  async function feedOnce() {
    await serial(async () => {
      await go(o.parsers.paths.feed)
      await o.eyes.onParsed(
        { recognized: false, signals: await o.parsers.fromHeaderDom(o.ab.page) },
        'dom',
      )
    })
  }

  async function chatsOnce(onlyUnread = true) {
    await serial(async () => {
      await go(o.parsers.paths.chats)
      const chats = await o.parsers.fromChatsDom(o.ab.page)
      for (const c of chats) {
        if (onlyUnread && c.unread === 0) continue
        await go(o.parsers.paths.chat(c.chatId))
        await o.eyes.onParsed(await o.parsers.fromChatDom(o.ab.page, c.chatId), 'dom')
      }
      // Back to the feed, where the event stream lives.
      await go(o.parsers.paths.feed)
    })
  }

  const timers = [
    setInterval(() => void feedOnce().catch(() => {}), o.feedEveryMs ?? 60000),
    setInterval(() => void chatsOnce().catch(() => {}), o.chatsEveryMs ?? 600000),
    setInterval(() => void o.eyes.checkSilence().catch(() => {}), 60000),
  ]

  return {
    stop: () => {
      for (const t of timers) clearInterval(t)
    },
    feedOnce,
    chatsOnce,
    // After a logout or an outage: the whole feed and every chat, not only unread ones (F8).
    async reconcile() {
      await feedOnce()
      await chatsOnce(false)
    },
  }
}
