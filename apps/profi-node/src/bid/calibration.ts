import { and, eq, sql } from 'drizzle-orm'
import type { Page, Response } from 'playwright'
import type { NodeDb } from '../db/client'
import { rawEvent } from '../db/schema'
import type { Eyes } from '../eyes/eyes'
import { readFormMap } from '../eyes/formMap'
import type { Parsers } from '../eyes/parsers'
import { formOnScreen, openForm } from './form'
import { type OrderScreen, orderScreenFromAnswer } from './screen'

// Words of a press that sends or pays: never pressed to open the form, whatever the answer names.
const PAYING = /Откликнуться|Оплат|Отправить|Подтвердить|Пополнить|Купить|Подключить/i
const HOUR = 3600_000

/**
 * The node opens the bid form itself to map it (Boris, 24.10.2026: old Sara pressed «Продолжить» too; only the final
 * «Откликнуться» spends). On an order page the minute check already opened, at most perHour times an hour, only for
 * an open order without our bid: press what the order answer names as the opener, map the opened form, touch nothing
 * else; the check then leaves the page. A wallet that went down meanwhile stops it for good, restarts included.
 */
export function startFormCalibration(o: {
  accountId: string
  db: NodeDb
  page(): Page
  eyes: Pick<Eyes, 'onRaw'>
  parsers: Pick<Parsers, 'fromHeaderDom'>
  perHour?: number
  now?: () => number
}): { afterOrderPage(orderId: string): Promise<void>; stop(): void } {
  const perHour = o.perHour ?? 3
  const now = o.now ?? Date.now
  const page = o.page()
  // The latest answer about each order the tab saw (the page asks for it while it loads).
  const screens = new Map<string, { at: number; screen: OrderScreen }>()
  let opens: number[] = []
  let halted: boolean | null = null

  const onResponse = async (res: Response) => {
    if (!/\/graphql/.test(res.url())) return
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
  // A map that saw the wallet go down: written by this node before, so a restart keeps the stop.
  const stoppedBefore = async () => {
    const rows = await o.db
      .select({ id: rawEvent.id })
      .from(rawEvent)
      .where(
        and(
          eq(rawEvent.accountId, o.accountId),
          eq(rawEvent.kind, 'dom'),
          sql`${rawEvent.body}->>'what' = 'bid_form'`,
          sql`(${rawEvent.body}->>'walletAfter')::int < (${rawEvent.body}->>'walletBefore')::int`,
        ),
      )
      .limit(1)
    return rows.length > 0
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
    async afterOrderPage(orderId) {
      halted ??= await stoppedBefore()
      if (halted) return
      opens = opens.filter((t) => now() - t < HOUR)
      if (opens.length >= perHour) return
      const s = await answerOf(orderId)
      if (!s || !s.open || s.hasBid !== false) return
      if (s.openerText && PAYING.test(s.openerText)) return
      // Open already: the visit's own map has it.
      if (await formOnScreen(page)) return
      opens.push(now())
      const before = await wallet()
      const opened = await openForm(page, s.openerText, 8000)
      // The payment block may come a moment after the fields.
      if (opened) await page.waitForTimeout(1500)
      const map = await readFormMap(page)
      const after = await wallet()
      if (before !== null && after !== null && after < before) {
        halted = true
        console.error(
          `Кошелёк уменьшился после открытия формы отклика (${before} ₽ → ${after} ₽), узел больше не открывает её сам`,
        )
      }
      await o.eyes
        .onRaw({
          kind: 'dom',
          url: page.url(),
          body: {
            ...(map ?? { what: 'bid_form' }),
            opened,
            openedBy: s.openerText,
            walletBefore: before,
            walletAfter: after,
          },
          receivedAt: new Date().toISOString(),
        })
        .catch(() => {})
    },
    stop: () => {
      page.off('response', onResponse)
    },
  }
}
