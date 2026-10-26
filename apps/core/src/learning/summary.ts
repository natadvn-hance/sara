import { formatCallback, newEventId, plural } from '@sara/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { jobRun, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'

/** The summary comes at 19:00 Moscow time with up to this many borderline orders. */
export const SUMMARY_HOUR_MSK = 19
const BORDERLINE_MAX = 3
/** Borderline: at most this many points under the threshold, no stop factor. */
const BORDERLINE_BELOW = 10
/** Orders held over the day's card cap listed with a button; the rest are only counted. */
const HELD_MAX = 10
/** A held order is offered while it is under a day old (FR-LEAD-10), and an hour more for a summary that runs late. */
const HELD_MAX_AGE = "interval '25 hours'"
/** A held order is waiting for Boris once a summary has offered it: it is not offered, or aged out, a second time. */
const OFFERED = `exists (select 1 from core.task k where k.kind = 'lead_held' and k.entity_id = l.id and k.state = 'open')`

/** The «ещё показала бы» part (FR-NOTIF-3); the texts stay here while part C owns notify/cards.ts. */
const HELD_TEXTS = {
  head: 'Ещё показала бы, карточек за день было больше лимита:',
  line: (n: number, h: Held) =>
    `${n}. ${h.title}, ${h.score === null ? 'без оценки' : `балл ${h.score}`}`,
  more: (n: number) => `И ещё ${n} ${plural(n, ['заявка', 'заявки', 'заявок'])}`,
  button: (n: number) => `Показать №${n}`,
}

export const mskParts = (d: Date) => {
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
type Held = { leadId: string; title: string; score: number | null }

/**
 * Once a Moscow day after 19:00: how many orders Sara dropped since yesterday's summary, and the borderline ones with «Взял бы»
 * (FR-LEAD-7); then the orders held over the card cap, best first, with «Показать» (FR-NOTIF-3), whenever they were
 * held. The day's row in
 * job_run is taken first, so two ticks or two cores send it once.
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
  // Held orders do not wait for their own window: whichever summary comes next offers them, as long as they are
  // fresh. Those that outlived that without being offered leave the held orders for good.
  const at = sql`${now.toISOString()}::timestamptz`
  // The aging and its journal entries are one change: an order never leaves the held ones without its event.
  await d.db.transaction(async (tx) => {
    const aged = await tx.execute<{
      id: string
      accountId: string
      correlationId: string
      seenAt: string
    }>(sql`
      update core.lead l set status = 'stale'
      where l.status = 'held' and l.seen_at <= ${at} - ${sql.raw(HELD_MAX_AGE)} and not ${sql.raw(OFFERED)}
      returning l.id, l.account_id as "accountId", l.correlation_id as "correlationId", l.seen_at as "seenAt"`)
    for (const l of aged.rows)
      await appendEvent(tx, {
        type: 'lead.stale',
        v: 1,
        entity: { kind: 'lead', id: l.id },
        account_id: l.accountId,
        actor: 'sara',
        occurred_at: now.toISOString(),
        causation_id: null,
        correlation_id: l.correlationId,
        reason: null,
        payload: { seen_at: new Date(l.seenAt).toISOString(), held: true },
      })
  })
  // Value first (FR-LEAD-10): the higher score, then the cheaper bid.
  const heldRows = await d.db.execute<Held>(sql`
    select l.id as "leadId", l.title, s.score
    from core.lead l
    left join lateral (
      select s.score from core.lead_score s
      where s.lead_id = l.id and not s.backtest
      order by s.created_at desc limit 1
    ) s on true
    where l.status = 'held' and l.seen_at > ${at} - ${sql.raw(HELD_MAX_AGE)} and not ${sql.raw(OFFERED)}
    order by s.score desc nulls last, l.bid_price_rub, l.seen_at`)
  const held = heldRows.rows
  if (dropped === 0 && held.length === 0) return 'none'

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
  const shown = held.slice(0, HELD_MAX)
  const lines: string[] = []
  if (dropped > 0) {
    if (picks.length === 0) lines.push(TEXTS.summaryNone(dropped))
    else
      lines.push(
        TEXTS.summaryHead(dropped),
        ...picks.map((p, i) => `${i + 1}. ${p.title}, балл ${p.score}: ${p.reason}`),
      )
  }
  if (shown.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(HELD_TEXTS.head, ...shown.map((h, i) => HELD_TEXTS.line(picks.length + i + 1, h)))
    if (held.length > shown.length) lines.push(HELD_TEXTS.more(held.length - shown.length))
  }
  try {
    if (picks.length === 0 && shown.length === 0) {
      await d.notifier.sendText(lines.join('\n'))
      return 'sent'
    }
    const items = [
      ...picks.map((p) => ({ leadId: p.leadId, kind: 'lead_review', action: 'want' as const })),
      ...shown.map((h) => ({ leadId: h.leadId, kind: 'lead_held', action: 'open' as const })),
    ].map((x) => ({ ...x, id: newEventId() }))
    const ids = items.map((x) => x.id)
    await d.db
      .insert(task)
      .values(
        items.map((x) => ({ id: x.id, kind: x.kind, entityKind: 'lead', entityId: x.leadId })),
      )
    try {
      await d.notifier.sendButtons(
        lines.join('\n'),
        items.map((x, i) => [
          {
            text: x.action === 'want' ? TEXTS.wantButton(i + 1) : HELD_TEXTS.button(i + 1),
            callbackData: formatCallback(x.id, x.action),
          },
        ]),
      )
    } catch (e) {
      await d.db
        .delete(task)
        .where(and(inArray(task.id, ids), inArray(task.kind, ['lead_review', 'lead_held'])))
      throw e
    }
    return 'sent'
  } catch (e) {
    // Not sent: the day is free again, the next tick tries once more.
    await d.db.delete(jobRun).where(and(eq(jobRun.name, 'summary'), eq(jobRun.day, day)))
    throw e
  }
}
