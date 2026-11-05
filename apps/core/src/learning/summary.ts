import {
  formatCallback,
  type KindThresholds,
  LeadScreen,
  leadKind,
  newEventId,
  thresholdFor,
} from '@sara/shared'
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { jobRun, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { screenBreakdown } from '../leads/screen'
import { staleCardsSince } from '../leads/waiting'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { NOT_TEST } from '../testLeads/sql'
import { type DayCounts, summaryText } from './summaryText'

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

/** The button of a held order; the texts of the report are in summaryText. */
const heldButton = (n: number) => `Показать №${n}`

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

type Borderline = {
  leadId: string
  title: string
  score: number
  reason: string
  threshold: number
}
type Held = { leadId: string; title: string; score: number | null }

/** The day's way from the board to the bids; test orders never count. */
async function dayCounts(db: Db, today: SQL, end: SQL): Promise<DayCounts> {
  const seen = await db.execute<{ seen: number; sorted: number; scored: number }>(sql`
    select count(*)::int as seen,
      (count(*) filter (where l.status = 'sorted_out'))::int as sorted,
      (count(*) filter (where l.status = 'scored_out'))::int as scored
    from core.lead l where ${today} and ${NOT_TEST('l.id')}`)
  const cards = await db.execute<{ category: string }>(sql`
    select l.category from core.lead l
    where ${today} and ${NOT_TEST('l.id')}
      and exists (select 1 from core.task t where t.kind = 'lead_decision' and t.entity_id = l.id)`)
  const bids = await db.execute<{ bids: number; spent: number }>(sql`
    select count(*)::int as bids, coalesce(sum((e.payload->>'spent_rub')::int), 0)::int as spent
    from core.event e
    where e.type = 'bid.sent' and ${NOT_TEST('e.entity_id')}
      and e.occurred_at > ${end} - interval '1 day' and e.occurred_at <= ${end}`)
  const kinds = cards.rows.map((c) => leadKind(c.category))
  const count = (k: string) => kinds.filter((x) => x === k).length
  return {
    seen: seen.rows[0]?.seen ?? 0,
    sorted: seen.rows[0]?.sorted ?? 0,
    scored: seen.rows[0]?.scored ?? 0,
    marketing: count('marketing'),
    sites: count('sites'),
    other: count('other'),
    bids: bids.rows[0]?.bids ?? 0,
    spentRub: bids.rows[0]?.spent ?? 0,
  }
}

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
  // The screen's line (docs/product/lead-analysis.md): what it stopped in the day's window, or in the shadow would have.
  const screens = await d.db.execute<{ screen: unknown }>(
    sql`select l.screen from core.lead l where l.screen is not null and ${today}`,
  )
  const screen = screenBreakdown(
    screens.rows.flatMap((r) => {
      const s = LeadScreen.safeParse(r.screen)
      return s.success ? [s.data] : []
    }),
  )
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
  const expired = await staleCardsSince(d.db, new Date(now.getTime() - 24 * 3600_000))
  if (dropped === 0 && held.length === 0 && screen.stopped + screen.marked === 0 && expired === 0)
    return 'none'

  // The threshold depends on the kind of the order, so the band under it is cut here and not in the query.
  const rows = await d.db.execute<
    Borderline & { category: string; threshold: number; kindThresholds: KindThresholds | null }
  >(sql`
    select l.id as "leadId", l.title, s.score, s.reason, l.category,
      (v.rules->>'threshold')::int as threshold, v.rules->'kind_thresholds' as "kindThresholds"
    from core.lead l
    join lateral (
      select * from core.lead_score s
      where s.lead_id = l.id and not s.backtest
      order by s.created_at desc limit 1
    ) s on true
    join core.direction_version v on v.account_id = l.account_id and v.version = s.version
    left join core.lead_label b on b.lead_id = l.id
    where l.status = 'scored_out' and ${today} and s.stop_factor is null and b.lead_id is null
    order by s.score desc, l.seen_at`)
  const picks: Borderline[] = rows.rows
    .flatMap((r) => {
      const threshold = thresholdFor(
        { threshold: r.threshold, kind_thresholds: r.kindThresholds ?? undefined },
        r.category,
      )
      return r.score < threshold && r.score >= threshold - BORDERLINE_BELOW
        ? [{ leadId: r.leadId, title: r.title, score: r.score, reason: r.reason, threshold }]
        : []
    })
    .slice(0, BORDERLINE_MAX)
  const shown = held.slice(0, HELD_MAX)
  const text = summaryText({
    now,
    counts: await dayCounts(d.db, today, end),
    screen,
    near: picks.map((p) => ({
      orderId: p.leadId,
      title: p.title,
      score: p.score,
      threshold: p.threshold,
      reason: p.reason,
    })),
    held: shown.map((h) => ({ orderId: h.leadId, title: h.title, score: h.score })),
    heldMore: held.length - shown.length,
    expired,
  })
  try {
    if (picks.length === 0 && shown.length === 0) {
      await d.notifier.sendText(text, { html: true })
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
        text,
        items.map((x, i) => [
          {
            text: x.action === 'want' ? TEXTS.wantButton(i + 1) : heldButton(i + 1),
            callbackData: formatCallback(x.id, x.action),
          },
        ]),
        { html: true },
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
