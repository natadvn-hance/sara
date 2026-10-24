import { formatCallback, newEventId } from '@sara/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { jobRun, task } from '../db/schema'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'

/** The summary comes at 19:00 Moscow time with up to this many borderline orders. */
export const SUMMARY_HOUR_MSK = 19
const BORDERLINE_MAX = 3
/** Borderline: at most this many points under the threshold, no stop factor. */
const BORDERLINE_BELOW = 10

const mskParts = (d: Date) => {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? ''
  return { day: `${v('year')}-${v('month')}-${v('day')}`, hour: Number(v('hour')) }
}

type Borderline = { leadId: string; title: string; score: number; reason: string }

/**
 * Once a Moscow day after 19:00: how many orders Sara dropped since yesterday's summary, and the borderline ones with «Взял бы»
 * (FR-LEAD-7). The day's row in job_run is taken first, so two ticks or two cores send it once.
 */
export async function dailySummary(
  d: { db: Db; notifier: Pick<Notifier, 'sendText' | 'sendButtons'> },
  now: Date,
): Promise<'sent' | 'none' | 'already' | 'not_yet'> {
  const { day, hour } = mskParts(now)
  if (hour < SUMMARY_HOUR_MSK) return 'not_yet'
  const taken = await d.db
    .insert(jobRun)
    .values({ name: 'summary', day })
    .onConflictDoNothing()
    .returning({ day: jobRun.day })
  if (taken.length === 0) return 'already'

  // The day's window ends at today's summary time and starts at yesterday's, so an order dropped in the
  // evening goes into tomorrow's summary instead of none.
  const end = sql`((${day}::date + make_interval(hours => ${SUMMARY_HOUR_MSK}))::timestamp at time zone 'Europe/Moscow')`
  const today = sql`l.seen_at > ${end} - interval '1 day' and l.seen_at <= ${end}`
  const counted = await d.db.execute<{ n: number }>(
    sql`select count(*)::int as n from core.lead l where l.status = 'scored_out' and ${today}`,
  )
  const dropped = counted.rows[0]?.n ?? 0
  if (dropped === 0) return 'none'

  const rows = await d.db.execute<Borderline>(sql`
    select l.id as "leadId", l.title, s.score, s.reason
    from core.lead l
    join lateral (
      select * from core.lead_score s
      where s.lead_id = l.id and not s.backtest
      order by s.created_at desc limit 1
    ) s on true
    join core.direction_version v on v.account_id = l.account_id and v.version = s.version
    left join core.lead_label b on b.lead_id = l.id
    where l.status = 'scored_out' and ${today} and s.stop_factor is null and b.lead_id is null
      and s.score < (v.rules->>'threshold')::int
      and s.score >= (v.rules->>'threshold')::int - ${BORDERLINE_BELOW}
    order by s.score desc, l.seen_at
    limit ${BORDERLINE_MAX}`)
  const picks = rows.rows
  try {
    if (picks.length === 0) {
      await d.notifier.sendText(TEXTS.summaryNone(dropped))
      return 'sent'
    }
    const ids = picks.map(() => newEventId())
    await d.db.insert(task).values(
      picks.map((p, i) => ({
        id: ids[i] as string,
        kind: 'lead_review',
        entityKind: 'lead',
        entityId: p.leadId,
      })),
    )
    try {
      await d.notifier.sendButtons(
        [
          TEXTS.summaryHead(dropped),
          ...picks.map((p, i) => `${i + 1}. ${p.title}, балл ${p.score}: ${p.reason}`),
        ].join('\n'),
        picks.map((_, i) => [
          { text: TEXTS.wantButton(i + 1), callbackData: formatCallback(ids[i] as string, 'want') },
        ]),
      )
    } catch (e) {
      await d.db.delete(task).where(and(inArray(task.id, ids), eq(task.kind, 'lead_review')))
      throw e
    }
    return 'sent'
  } catch (e) {
    // Not sent: the day is free again, the next tick tries once more.
    await d.db.delete(jobRun).where(and(eq(jobRun.name, 'summary'), eq(jobRun.day, day)))
    throw e
  }
}
