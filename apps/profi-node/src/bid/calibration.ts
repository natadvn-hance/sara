import { and, eq, gt, sql, sum } from 'drizzle-orm'
import type { Page, Response } from 'playwright'
import type { NodeDb } from '../db/client'
import { bidAttempt, nodeFlag, rawEvent } from '../db/schema'
import type { Eyes } from '../eyes/eyes'
import { readFormMap } from '../eyes/formMap'
import type { Parsers } from '../eyes/parsers'
import { formOnScreen, openForm } from './form'
import { type OrderScreen, orderScreenFromAnswer } from './screen'

// The only presses the node makes on its own (src/bid/form.ts openForm): «Продолжить» with the order's own fee in the
// tariff block, as on the live page of 24.10.2026, or «Написать клиенту» when the answer names it the opener. Other
// words are not pressed, whatever the answer says: a developer looks at the map and adds them.
const SELF_OPENER = 'Написать клиенту'
const STOP = 'form_calibration'
const HOUR = 3600_000
const ORDER_PAGE = /\/n\.php\?(?:.*&)?o=(\d+)/

/**
 * The node opens the bid form itself to map it (Boris, 24.10.2026: old Sara pressed «Продолжить» too; only the final
 * «Откликнуться» spends). On an order page the minute check already opened, at most perHour times an hour, only for
 * an open order without our bid and only while the tab may move: press «Продолжить N ₽» (or «Написать клиенту»), map
 * the opened form with the wallet before and after, touch nothing else; the check then leaves the page.
 * Any sign of money gone stops it until a person clears node.node_flag: the wallet lower right after the press, or
 * on the next page the check opens, or unreadable after it, or the press leading off the order page.
 */
export function startFormCalibration(o: {
  accountId: string
  db: NodeDb
  page(): Page
  eyes: Pick<Eyes, 'onRaw'>
  parsers: Pick<Parsers, 'fromHeaderDom'>
  perHour?: number
  now?: () => number
}): { afterOrderPage(orderId: string, may: () => boolean): Promise<void>; stop(): void } {
  const perHour = o.perHour ?? 3
  const now = o.now ?? Date.now
  const page = o.page()
  // The latest answer about each order, caught while its page loads.
  const screens = new Map<string, { at: number; screen: OrderScreen }>()
  // null: not read from the database yet.
  let halted: boolean | null = null
  let haltWritten = true
  // After a press: the next fresh page must show the same wallet, less what bids spent since.
  let pending: { walletAfter: number; at: Date } | null = null

  const onResponse = async (res: Response) => {
    // Only on an order page: chat polls and the like are not read.
    if (!ORDER_PAGE.test(page.url()) || !/\/graphql/.test(res.url())) return
    const body = await res.json().catch(() => null)
    const orders = (body as { data?: { orders?: unknown } } | null)?.data?.orders
    if (!Array.isArray(orders)) return
    for (const x of orders as ({ _id?: unknown } | null)[]) {
      const id = String(x?._id ?? '')
      const screen = id ? orderScreenFromAnswer(res.url(), body, id) : null
      if (!screen) continue
      if (screens.size >= 50) screens.delete(screens.keys().next().value ?? '')
      screens.set(id, { at: now(), screen })
    }
  }
  page.on('response', onResponse)

  const wallet = async () => {
    const signals = await o.parsers.fromHeaderDom(page).catch(() => [])
    const s = signals.find((x) => x.t === 'balance')
    return s && s.t === 'balance' ? s.rub : null
  }
  const writeHalt = async (reason: string) => {
    await o.db
      .insert(nodeFlag)
      .values({ accountId: o.accountId, name: STOP, reason, setAt: new Date().toISOString() })
      .onConflictDoNothing()
  }
  async function halt(reason: string) {
    halted = true
    console.error(`${reason}: узел больше не открывает форму отклика сам`)
    haltWritten = await writeHalt(reason).then(
      () => true,
      () => false,
    )
  }
  async function stopped(): Promise<boolean> {
    if (halted === null) {
      const rows = await o.db
        .select({ name: nodeFlag.name })
        .from(nodeFlag)
        .where(and(eq(nodeFlag.accountId, o.accountId), eq(nodeFlag.name, STOP)))
      halted = rows.length > 0
    }
    // A stop that could not be written is written again, so a restart keeps it.
    if (halted && !haltWritten)
      haltWritten = await writeHalt('повтор записи остановки').then(
        () => true,
        () => false,
      )
    return halted
  }
  const opensLastHour = async () => {
    const rows = await o.db
      .select({ n: sql<number>`count(*)::int` })
      .from(rawEvent)
      .where(
        and(
          eq(rawEvent.accountId, o.accountId),
          eq(rawEvent.kind, 'dom'),
          sql`${rawEvent.body} ? 'opened'`,
          gt(rawEvent.receivedAt, new Date(now() - HOUR).toISOString()),
        ),
      )
    return rows[0]?.n ?? 0
  }
  const spentSince = async (at: Date) => {
    const [r] = await o.db
      .select({ rub: sum(bidAttempt.dueRub) })
      .from(bidAttempt)
      .where(and(eq(bidAttempt.accountId, o.accountId), gt(bidAttempt.pressedAt, at.toISOString())))
    return Number(r?.rub ?? 0)
  }
  const answerOf = async (orderId: string) => {
    for (let i = 0; i < 12; i++) {
      const seen = screens.get(orderId)
      if (seen && now() - seen.at < 2 * 60_000) return seen.screen
      await new Promise((r) => setTimeout(r, 250))
    }
    return null
  }

  return {
    async afterOrderPage(orderId, may) {
      if (await stopped()) return
      const before = await wallet()
      if (pending) {
        const was = pending
        pending = null
        const spent = await spentSince(was.at)
        if (before === null || before < was.walletAfter - spent)
          return halt(
            `Кошелёк после открытия формы: ${was.walletAfter} ₽, на следующей странице ${before ?? '?'} ₽`,
          )
      }
      if (before === null || !may() || (await opensLastHour()) >= perHour) return
      const s = await answerOf(orderId)
      if (!s || !s.open || s.hasBid !== false || s.feeRub === null) return
      const words =
        s.openerText === SELF_OPENER && s.submitText !== SELF_OPENER ? SELF_OPENER : null
      // Open already: the visit's own map has it.
      if (await formOnScreen(page)) return
      const r = await openForm(page, { words, feeRub: s.feeRub }, 8000, {
        may,
        september: false,
      })
      if (!r.pressed) return
      const pressedAt = new Date()
      const stayed = ORDER_PAGE.exec(page.url())?.[1] === orderId
      // The payment block may come a moment after the fields.
      if (r.open) await page.waitForTimeout(1500)
      const map = stayed ? await readFormMap(page) : null
      const after = stayed ? await wallet() : null
      await o.eyes
        .onRaw({
          kind: 'dom',
          url: page.url(),
          body: {
            ...(map ?? { what: 'bid_form' }),
            opened: r.open,
            openedBy: r.by,
            walletBefore: before,
            walletAfter: after,
          },
          receivedAt: new Date(now()).toISOString(),
        })
        .catch(() => {})
      if (!stayed) return halt(`После «${r.by}» вкладка ушла со страницы заказа`)
      if (after === null || after < before)
        return halt(`Кошелёк при открытии формы: ${before} ₽, после ${after ?? '?'} ₽`)
      pending = { walletAfter: after, at: pressedAt }
    },
    stop: () => {
      page.off('response', onResponse)
    },
  }
}
