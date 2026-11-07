import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { NOT_TEST } from '../testLeads/sql'
import { MONTHS } from './analytics'

/** A call with no word on it this long after its start counts as «нет итога». */
const WORD_GRACE_MS = 3 * 3_600_000

export type MeetingMonth = {
  month: string
  /** Назначено: every call that stood (not a «maybe», not cancelled, not a duplicate). */
  booked: number
  /** Прошло: Boris or Lora said it took place. */
  held: number
  /** Не состоялось. */
  missed: number
  /** The time has passed and nobody has said how it went. */
  noWord: number
}

/**
 * Calls by month of their start (Moscow time): booked, held, missed and still without a word. One function for the
 * pult, the Google Sheet and the monthly summary. Boris's own sheet formulas are not touched.
 */
export async function meetingStats(
  db: DbOrTx,
  year: number,
  now: Date = new Date(),
): Promise<MeetingMonth[]> {
  const r = await db.execute<{
    month: number
    outcome: string | null
    starts_at: string | Date
  }>(sql`
    select extract(month from (m.starts_at at time zone 'Europe/Moscow'))::int as month,
           m.outcome, m.starts_at
      from core.meeting m
      join core.conversation c on c.id = m.conversation_id
         where m.status not in ('maybe', 'cancelled', 'duplicate')
       and m.starts_at is not null
       and extract(year from (m.starts_at at time zone 'Europe/Moscow'))::int = ${year}
       and ${NOT_TEST('c.order_id')}
  `)
  const list = r.rows
  const out: MeetingMonth[] = MONTHS.map((month) => ({
    month,
    booked: 0,
    held: 0,
    missed: 0,
    noWord: 0,
  }))
  for (const r of list) {
    const o = out[Number(r.month) - 1]
    if (!o) continue
    o.booked++
    if (r.outcome === 'held') o.held++
    else if (r.outcome === 'missed') o.missed++
    else if (now.getTime() - new Date(r.starts_at).getTime() > WORD_GRACE_MS) o.noWord++
  }
  const sum = (k: 'booked' | 'held' | 'missed' | 'noWord') => out.reduce((a, m) => a + m[k], 0)
  out.push({
    month: 'ИТОГО',
    booked: sum('booked'),
    held: sum('held'),
    missed: sum('missed'),
    noWord: sum('noWord'),
  })
  return out
}
