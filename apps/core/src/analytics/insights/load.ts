import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../../db/client'
import { logRows, reachedStage } from '../../pult/analytics'
import { NOT_TEST } from '../../testLeads/sql'
import type { BidFeature, SeenFeature } from './findings'

/** How far back the hypotheses look. */
export const WINDOW_DAYS = 60

type Row = {
  lead_id: string
  bid_at: string
  seen_at: string
  price: number | null
  score: number | null
  series: boolean
  replied: boolean
}

/**
 * The bids of the window with what a hypothesis may name. The funnel (service, stage, refunded) comes from `logRows`, the
 * same rows as Boris's sheet. Stages are read only when `stages` says they can be trusted (a deal moves on the client's
 * first word, which the first fix of the forum session brings); until then no hypothesis about stages is made.
 */
export async function loadBids(
  db: DbOrTx,
  since: Date,
  o: { stages: boolean },
): Promise<BidFeature[]> {
  const funnel = new Map(
    (await logRows(db, { since: since.toISOString() })).map((r) => [r.orderId, r]),
  )
  const r = await db.execute<Row>(sql`
    with b as (
      select entity_id as lead_id, min(occurred_at) as bid_at from core.event
      where type = 'bid.sent' and ${NOT_TEST('entity_id')} group by entity_id
    )
    select b.lead_id, b.bid_at, l.seen_at,
      coalesce(l.draft_price_rub, l.bid_price_rub) as price,
      (select s.score from core.lead_score s
        where s.lead_id = b.lead_id and not s.backtest order by s.created_at desc limit 1) as score,
      (coalesce(jsonb_array_length(l.draft_follow_ups), 0) > 0
        or exists (select 1 from core.chat_message m
          where m.order_id = b.lead_id and m.author not in ('client', 'system')
            and m.sent_at > b.bid_at + interval '5 seconds' and m.sent_at <= b.bid_at + interval '15 minutes'
            and not exists (select 1 from core.chat_message c
              where c.order_id = b.lead_id and c.author = 'client' and c.sent_at < m.sent_at))) as series,
      exists (select 1 from core.chat_message m
        where m.order_id = b.lead_id and m.author = 'client' and m.sent_at > b.bid_at) as replied
    from b join core.lead l on l.id = b.lead_id
    where b.bid_at >= ${since.toISOString()}::timestamptz
    order by b.bid_at`)
  return r.rows.flatMap((x) => {
    const f = funnel.get(x.lead_id)
    if (!f) return []
    const bidAt = new Date(x.bid_at).toISOString()
    const delay = (Date.parse(bidAt) - Date.parse(new Date(x.seen_at).toISOString())) / 60000
    return [
      {
        bidAt,
        delayMin: delay >= 0 ? Math.round(delay * 10) / 10 : null,
        priceRub: x.price,
        score: x.score,
        service: f.service,
        hour: Number(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Moscow',
            hour: '2-digit',
            hourCycle: 'h23',
          }).format(new Date(bidAt)),
        ),
        series: x.series,
        replied: x.replied,
        opened: !f.refunded,
        negotiated: o.stages ? reachedStage(f.stage, 'Переговоры') : null,
      },
    ]
  })
}

/** Every order Sara saw in the window and how long after its publication (null: the publication time is not known). */
export async function loadSeen(db: DbOrTx, since: Date): Promise<SeenFeature[]> {
  const r = await db.execute<{ category: string; hour: number; late: number | null }>(sql`
    select l.category,
      extract(hour from (l.seen_at at time zone 'Europe/Moscow'))::int as hour,
      extract(epoch from (l.seen_at - (e.payload->>'published_at')::timestamptz)) / 60 as late
    from core.lead l
    left join lateral (
      select payload from core.event e
      where e.type = 'profi.order_seen' and e.entity_kind = 'order' and e.entity_id = l.id
        and e.payload->>'published_at' ~ '^[0-9]{4}-'
      order by e.id limit 1) e on true
    where l.seen_at >= ${since.toISOString()}::timestamptz and ${NOT_TEST('l.id')}`)
  return r.rows.map((x) => ({
    category: x.category.trim(),
    hour: x.hour,
    lateMin: x.late === null || x.late < 0 ? null : Math.round(Number(x.late) * 10) / 10,
  }))
}
