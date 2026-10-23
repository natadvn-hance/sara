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

async function gaps(db: DbOrTx, from: string, to: string, toFilter: string): Promise<number[]> {
  const rows = await db.execute<{ ms: number }>(sql`
    select extract(epoch from (b.occurred_at - a.occurred_at)) * 1000 as ms
    from core.event a
    join core.event b on b.correlation_id = a.correlation_id and b.type = ${to}
    where a.type = ${from} ${sql.raw(toFilter)}`)
  return rows.rows.map((r) => Number(r.ms))
}

/** G1 and G2 measured from the journal: lead found to card, Boris's yes to bid sent. */
export async function speedReport(db: DbOrTx): Promise<SpeedReport> {
  const leadToCard = await gaps(db, 'lead.found', 'task.created', '')
  const yesToBid = await gaps(db, 'task.resolved', 'bid.sent', `and a.payload->>'action' = 'bid'`)
  return { leadToCard: stat(leadToCard), yesToBid: stat(yesToBid) }
}
