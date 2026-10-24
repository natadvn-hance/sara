import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'

export type Stat = {
  count: number
  p50Ms: number | null
  p90Ms: number | null
  p95Ms: number | null
}
export type SpeedReport = { leadToCard: Stat; yesToBid: Stat }

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, i)] ?? null
}

function stat(values: number[]): Stat {
  const s = [...values].sort((a, b) => a - b)
  return {
    count: s.length,
    p50Ms: percentile(s, 50),
    p90Ms: percentile(s, 90),
    p95Ms: percentile(s, 95),
  }
}

async function ms(db: DbOrTx, q: ReturnType<typeof sql>): Promise<number[]> {
  const rows = await db.execute<{ ms: number }>(q)
  return rows.rows.map((r) => Number(r.ms))
}

/**
 * G1 and G2 measured from the journal (FR-ANL-3). Lead to card: from lead.found to the order's own card really
 * sent (card.sent via 'order'), so the Analyst and Telegram count; a card Boris brought from the summary hours
 * later or an edited one does not. Yes to bid: from the last press of «Откликнуться» before bid.sent, so a press
 * given back by a pause does not count twice.
 */
export async function speedReport(db: DbOrTx): Promise<SpeedReport> {
  const leadToCard = await ms(
    db,
    sql`
    select extract(epoch from (b.occurred_at - a.occurred_at)) * 1000 as ms
    from core.event a
    join lateral (
      select b.occurred_at from core.event b
      where b.correlation_id = a.correlation_id and b.type = 'card.sent'
        and b.payload->>'via' = 'order' and b.occurred_at >= a.occurred_at
      order by b.occurred_at, b.id limit 1
    ) b on true
    where a.type = 'lead.found'`,
  )
  const yesToBid = await ms(
    db,
    sql`
    select extract(epoch from (b.occurred_at - a.occurred_at)) * 1000 as ms
    from core.event b
    join lateral (
      select a.occurred_at from core.event a
      where a.correlation_id = b.correlation_id and a.type = 'task.resolved'
        and a.payload->>'action' = 'bid' and a.occurred_at <= b.occurred_at
      order by a.occurred_at desc, a.id desc limit 1
    ) a on true
    where b.type = 'bid.sent'`,
  )
  return { leadToCard: stat(leadToCard), yesToBid: stat(yesToBid) }
}
