import type { Page } from 'playwright'
import type { Eyes } from './eyes'
import { readFormMap } from './formMap'

const ORDER_PAGE = /\/n\.php\?(?:.*&)?o=\d+/

/**
 * The October bid form opens only after a press, which the node never makes on its own. While Boris works the live
 * screen on an order page, each new look of the page is mapped (reading only), so his own opening of the form
 * calibrates the bid.
 */
export function startWatchedMaps(o: {
  page(): Page
  eyes: Pick<Eyes, 'onRaw'>
  watched(): boolean
  everyMs?: number
}): { stop(): void; once(): Promise<void> } {
  let last = ''
  async function once() {
    if (!o.watched()) return
    const page = o.page()
    const url = page.url()
    if (!ORDER_PAGE.test(url)) return
    const map = await readFormMap(page)
    if (!map) return
    const look = `${url} ${JSON.stringify(map)}`
    if (look === last) return
    last = look
    await o.eyes
      .onRaw({
        kind: 'dom',
        url,
        body: { ...map, watched: true },
        receivedAt: new Date().toISOString(),
      })
      .catch(() => {})
  }
  const timer = setInterval(() => void once().catch(() => {}), o.everyMs ?? 3000)
  return { stop: () => clearInterval(timer), once }
}
