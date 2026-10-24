import { type DirectionRules, newEventId, ProfiOrder } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { leadScore } from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import { scoreOrder } from '../leads/scorer'

export type Backtest = { checked: number; changed: number; towardBoris: number; against: number }

/** How many of the latest decisions Boris made are rescored, to show what new rules would change. */
const BACKTEST_SIZE = 50

type Row = {
  id: string
  title: string
  category: string
  city: string
  text: string
  client_name: string
  budget_text: string | null
  bid_price_rub: number
  seen_at: string
  label: string
}

/**
 * The last 50 leads with Boris's decision and a live score, rescored under the old and the new rules on the same
 * model (haiku, no retry), so a change is the rules' doing and not a different model's. It is toward Boris when
 * the new decision matches his label. The new rules' scores are kept as backtest rows and never act on a lead.
 */
export async function backtest(
  d: { db: Db; gateway: Gateway },
  accountId: string,
  oldRules: DirectionRules,
  rules: DirectionRules,
  version: number,
): Promise<Backtest> {
  const rows = await d.db.execute<Row>(sql`
    select l.id, l.title, l.category, l.city, l.text, l.client_name, l.budget_text, l.bid_price_rub,
      to_char(l.seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as seen_at,
      b.label
    from core.lead_label b
    join core.lead l on l.id = b.lead_id
    join lateral (
      select * from core.lead_score s
      where s.lead_id = l.id and not s.backtest
      order by s.created_at desc limit 1
    ) s on true
    where l.account_id = ${accountId}
    order by b.at desc
    limit ${BACKTEST_SIZE}`)
  const out: Backtest = { checked: 0, changed: 0, towardBoris: 0, against: 0 }
  for (const r of rows.rows) {
    const order = ProfiOrder.parse({
      order_id: r.id,
      title: r.title,
      category: r.category,
      city: r.city,
      text: r.text,
      client_name: r.client_name,
      budget_text: r.budget_text,
      bid_price_rub: r.bid_price_rub,
      seen_at: r.seen_at,
    })
    const before = await scoreOrder(d.gateway, order, oldRules, { escalate: false })
    const s = await scoreOrder(d.gateway, order, rules, { escalate: false })
    if (!before || !s) continue
    out.checked++
    await d.db.insert(leadScore).values({
      id: newEventId(),
      leadId: r.id,
      version,
      score: s.score,
      decision: s.decision,
      stopFactor: s.stopFactor,
      redFlags: s.redFlags,
      axes: s.axes,
      reason: s.reason,
      confidence: s.confidence,
      model: s.model,
      backtest: true,
    })
    if (s.decision === before.decision) continue
    out.changed++
    const wanted = r.label === 'yes' ? 'show' : 'drop'
    if (s.decision === wanted) out.towardBoris++
    else out.against++
  }
  return out
}
