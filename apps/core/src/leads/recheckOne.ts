import { newEventId } from '@sara/shared'
import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { lead, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { type ProfiClient, ProfiError } from '../profi/client'

/**
 * «Перепроверить» on the lead's screen (pult v2 design 4): the order page read now, by Boris's press, at most once in
 * five minutes per lead. A closed order closes its card the same way the hourly recheck does; a new fee is kept on
 * the lead, so the next press pays what the page asks.
 */

const EVERY_MS = 5 * 60_000

export const RECHECK_TEXTS = {
  decided: 'Заявка уже решена, перепроверять нечего.',
  tooSoon: (min: number) => `Только что проверяла. Можно снова через ${min} мин.`,
  notRead: 'Профи.ру сейчас не открыл страницу заказа. Попробуй через несколько минут.',
  failed: (why: string) => `Не смогла открыть заказ: ${why}.`,
  closed: 'Заказ закрыт на Профи.ру. Карточку закрыла, денег не тратила.',
  open: 'Перечитала заказ: он открыт.',
  feeChanged: (was: number, now: number) =>
    `Перечитала заказ: он открыт, отклик теперь стоит ${now} ₽ (было ${was} ₽).`,
} as const

const ERROR_RU: Partial<Record<string, string>> = {
  SESSION_DEAD: 'Профи.ру разлогинил аккаунт',
  BANNED: 'профиль заблокирован',
  LAYOUT_CHANGED: 'Профи.ру поменял страницу заказа',
  NOT_FOUND: 'заказа больше нет на Профи.ру',
  RATE_LIMITED: 'Профи.ру просит подождать',
}

export function createRecheckOne(d: {
  db: Db
  profi: Pick<ProfiClient, 'getOrder'>
  /** Closes the card of this task (its order is closed on Profi.ru): the pipeline's `closeOnSite`. */
  close(taskId: string): Promise<void>
  now?: () => Date
}) {
  const last = new Map<string, number>()
  return async function recheckOne(leadId: string): Promise<{ message: string; closed: boolean }> {
    const [row] = await d.db
      .select({ t: task, l: lead })
      .from(task)
      .innerJoin(lead, eq(lead.id, task.entityId))
      .where(and(eq(task.entityId, leadId), eq(task.kind, 'lead_decision'), eq(task.state, 'open')))
      .orderBy(desc(task.createdAt))
      .limit(1)
    if (!row) return { message: RECHECK_TEXTS.decided, closed: false }
    const now = (d.now?.() ?? new Date()).getTime()
    const before = last.get(leadId)
    if (before !== undefined && now - before < EVERY_MS)
      return {
        message: RECHECK_TEXTS.tooSoon(Math.ceil((EVERY_MS - (now - before)) / 60_000)),
        closed: false,
      }
    last.set(leadId, now)
    const { t, l } = row
    let page: Awaited<ReturnType<ProfiClient['getOrder']>>
    try {
      page = await d.profi.getOrder(l.accountId, l.id)
    } catch (err) {
      const cls = err instanceof ProfiError ? err.errorClass : 'INTERNAL'
      return {
        message: RECHECK_TEXTS.failed(ERROR_RU[cls] ?? 'служба Профи.ру не ответила'),
        closed: false,
      }
    }
    const at = new Date(now).toISOString()
    await appendEvent(d.db, {
      type: 'lead.page_read',
      v: 1,
      entity: { kind: 'lead', id: l.id },
      account_id: l.accountId,
      actor: 'boris',
      occurred_at: at,
      causation_id: null,
      correlation_id: l.correlationId ?? newEventId(),
      reason: 'recheck from the pult',
      // The same payload as the hourly recheck's read, so its «last look» counts this one too.
      payload:
        page.from_page === true
          ? {
              ok: true,
              open: page.open,
              has_bid: page.has_bid,
              fee_rub: page.bid_price_rub > 0 ? page.bid_price_rub : null,
              client_info: page.client_info != null,
              error: null,
              via: 'pult',
            }
          : {
              ok: false,
              open: null,
              has_bid: null,
              fee_rub: null,
              client_info: false,
              error: 'NOT_READ',
              via: 'pult',
            },
    })
    // An answer the node gave from its store is no read: it would pass a closed order as open.
    if (page.from_page !== true) return { message: RECHECK_TEXTS.notRead, closed: false }
    if (page.open === false && page.has_bid !== true) {
      await d.close(t.id)
      return { message: RECHECK_TEXTS.closed, closed: true }
    }
    const fee = page.bid_price_rub
    if (fee > 0 && fee !== l.bidPriceRub) {
      await d.db.update(lead).set({ bidPriceRub: fee }).where(eq(lead.id, l.id))
      return { message: RECHECK_TEXTS.feeChanged(l.bidPriceRub, fee), closed: false }
    }
    return { message: RECHECK_TEXTS.open, closed: false }
  }
}
