import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { getSetting } from '../settings/store'

/** Card flow texts for Boris (Russian, plain, no long dash). */
export const CARD_FLOW_TEXTS = {
  staleHeld: 'Заявке больше суток, карточку не присылаю.',
  pageClosed: 'Заявка уже закрыта, карточку не присылаю.',
  pageBidAlready: 'На эту заявку уже есть отклик, карточку не присылаю.',
}

/** FR-LEAD-10: an order older than this is not offered. */
const STALE_AFTER_MS = 24 * 3600_000

/** Published over 24 hours ago; an order without a publication time is never stale. */
export function isStale(publishedAt: string | null | undefined, now: Date): boolean {
  if (!publishedAt) return false
  return now.getTime() - new Date(publishedAt).getTime() > STALE_AFTER_MS
}

/** The hour of `d` in Moscow, 0 to 23. */
export const mskHour = (d: Date) =>
  Number(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(d),
  )

/**
 * FR-NOTIF-2: the Moscow hour of `now` is inside the quiet hours: from `from`:00 up to `to`:00, past midnight
 * when from > to, all day when they are equal; null, never.
 */
export function isQuietHour(now: Date, q: { from: number; to: number } | null): boolean {
  if (!q) return false
  const h = mskHour(now)
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to
}

/** Cards go without sound now (setting cards.quiet_hours). */
export async function quietNow(db: DbOrTx, now: Date): Promise<boolean> {
  return isQuietHour(now, await getSetting(db, 'cards.quiet_hours'))
}

/**
 * FR-NOTIF-3: lead cards of the Moscow day of `now`, as decision tasks (a card the bot could not send yet still
 * counts, the reminder brings it). The caller holds the cards lock, so two orders at once cannot both take the
 * last place.
 */
export async function cardsToday(tx: DbOrTx, now: Date): Promise<number> {
  const r = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from core.task t
    where t.kind = 'lead_decision'
      and (t.created_at at time zone 'Europe/Moscow')::date
        = (${now.toISOString()}::timestamptz at time zone 'Europe/Moscow')::date`)
  return r.rows[0]?.n ?? 0
}

/** Serializes the card cap decision between orders processed at the same time. */
export async function lockCards(tx: DbOrTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sara:cards'))`)
}
