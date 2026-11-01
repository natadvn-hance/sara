import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { NOT_TEST } from '../testLeads/sql'

/** «Счёт за период» (the Secretary's `counts`): what the journal says about a span of Moscow days. Reads only. */

const MSK = 'Europe/Moscow'
const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 366

export const CountsInput = z
  .object({
    period: z.enum(['today', 'yesterday', 'week']).optional(),
    from: z.string().regex(DAY).optional(),
    to: z.string().regex(DAY).optional(),
  })
  .refine((i) => !(i.period && (i.from || i.to)), 'Либо period, либо from и to.')

export type CountsInput = z.infer<typeof CountsInput>

export type Counts = {
  /** The Moscow days counted, first and last inclusive (YYYY-MM-DD). */
  from: string
  to: string
  /** True when the span ends today: the counting stops at this minute, not at midnight. */
  untilNow: boolean
  /** Orders the node brought in. */
  found: number
  /** Orders the screen stopped («Отсев»). */
  screenedOut: number
  /** Orders that went on past the screen: found minus stopped. */
  passedScreen: number
  /** Orders that got a score. */
  scored: number
  /** Cards sent to Boris, one per task. */
  cards: number
  /** Bids that reached the client / bids that did not (one per order). */
  bidsSent: number
  bidsFailed: number
  spentRub: number
  /** Messages the clients wrote / answers Sara sent. */
  clientMessages: number
  saraReplies: number
}

const day = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: MSK,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)

/** The same day, `n` days later (calendar arithmetic on the date text, so Moscow midnight never slips). */
const shift = (ymd: string, n: number): string => {
  const [y, m, dd] = ymd.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10)
}

/** The first and last Moscow day of a request; null when it is not a span (from after to, too long, bad date). */
export function periodDays(i: CountsInput, now: Date): { from: string; to: string } | null {
  const today = day(now)
  let from = today
  let to = today
  if (i.period === 'yesterday') from = to = shift(today, -1)
  else if (i.period === 'week') from = shift(today, -6)
  else if (!i.period && (i.from || i.to)) {
    from = i.from ?? i.to ?? today
    to = i.to ?? i.from ?? today
  }
  const ok = (s: string) => shift(s, 0) === s
  if (!ok(from) || !ok(to) || from > to) return null
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= MAX_DAYS) return null
  return { from, to }
}

export async function periodCounts(
  db: Db,
  i: CountsInput,
  now = new Date(),
): Promise<Counts | null> {
  const days = periodDays(i, now)
  if (!days) return null
  const r = await db.execute<Omit<Counts, 'from' | 'to' | 'untilNow' | 'passedScreen'>>(sql`
    with b as (
      select
        (${days.from}::date::timestamp at time zone ${MSK}) as s,
        (${shift(days.to, 1)}::date::timestamp at time zone ${MSK}) as e
    ), ev as (
      select e.* from core.event e, b where e.occurred_at >= b.s and e.occurred_at < b.e
    ), chats as (
      select id::text as id from core.conversation
        where ${NOT_TEST('chat_id')} and ${NOT_TEST('order_id')}
    )
    select
      (select count(distinct entity_id)::int from ev where type = 'lead.found'
         and ${NOT_TEST('entity_id')}) as found,
      (select count(distinct entity_id)::int from ev where type = 'lead.screened'
         and (payload->>'stops')::boolean and (payload->>'out')::boolean
         and ${NOT_TEST('entity_id')}) as "screenedOut",
      (select count(distinct entity_id)::int from ev where type = 'lead.scored'
         and ${NOT_TEST('entity_id')}) as scored,
      (select count(distinct ev.entity_id)::int from ev
         join core.task t on t.id::text = ev.entity_id
         where ev.type = 'card.sent' and ${NOT_TEST('t.entity_id')}) as cards,
      (select count(distinct entity_id)::int from ev where type = 'bid.sent'
         and ${NOT_TEST('entity_id')}) as "bidsSent",
      (select count(distinct entity_id)::int from ev where type = 'bid.failed'
         and ${NOT_TEST('entity_id')}) as "bidsFailed",
      (select coalesce(sum((payload->>'amount_rub')::int), 0)::int from ev
         where type = 'spend.recorded' and ${NOT_TEST('entity_id')}) as "spentRub",
      (select count(*)::int from ev join chats c on c.id = ev.entity_id
         where ev.type = 'conv.message_heard' and ev.payload->>'author' = 'client') as "clientMessages",
      (select count(*)::int from ev join chats c on c.id = ev.payload->>'conversation_id'
         where ev.type = 'conv.turn_sent') as "saraReplies"`)
  const row = r.rows[0]
  if (!row) throw new Error('the count is not readable')
  return {
    from: days.from,
    to: days.to,
    untilNow: days.to >= day(now),
    passedScreen: Math.max(0, row.found - row.screenedOut),
    ...row,
  }
}
