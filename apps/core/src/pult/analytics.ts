import { type AnalyticsView, FUNNEL_STAGES, type FunnelStage } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { NOT_TEST } from '../testLeads/sql'

/**
 * Boris's three tables (docs/product/analytics-metrics.md) from what Sara knows today: bids and spends from the
 * journal, stages from the deals. Sums of contracts, payments and notes come with M6's outcomes; until then those
 * columns stay empty and the notes say so. One client is one name on one account (the platform's client number is
 * not stored yet).
 */

const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
]

/** A deal's stage as one of Boris's five. */
export function funnelStage(stage: string | null): FunnelStage {
  switch (stage) {
    case 'talking':
    case 'call_proposed':
      return 'Переговоры'
    case 'call_booked':
    case 'call_done':
      return 'В работе'
    case 'won':
      return 'Закрыта'
    case 'lost':
    case 'dormant':
      return 'Отвалился'
    default:
      return 'Отклик'
  }
}

const RANK: Record<FunnelStage, number> = {
  Отклик: 0,
  Переговоры: 1,
  'В работе': 2,
  Закрыта: 3,
  Отвалился: -1,
}

type BidRow = {
  lead_id: string
  account_id: string
  client: string
  category: string
  bid_at: string
  month: number
  stage: string | null
  spend: number
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null)

export async function analyticsView(db: DbOrTx, year: number): Promise<AnalyticsView> {
  const r = await db.execute<BidRow>(sql`
    with b as (
      select entity_id as lead_id, min(occurred_at) as bid_at from core.event
      where type = 'bid.sent' and ${NOT_TEST('entity_id')} group by entity_id
    ), s as (
      select entity_id as lead_id, sum((payload->>'amount_rub')::int)::int as spend from core.event
      where type = 'spend.recorded' and ${NOT_TEST('entity_id')} group by entity_id
    )
    select b.lead_id, l.account_id, l.client_name as client, l.category, b.bid_at,
      extract(month from b.bid_at at time zone 'Europe/Moscow')::int as month,
      d.stage, coalesce(s.spend, 0)::int as spend
    from b
    join core.lead l on l.id = b.lead_id
    left join core.deal d on d.lead_id = b.lead_id
    left join s on s.lead_id = b.lead_id
    where extract(year from b.bid_at at time zone 'Europe/Moscow')::int = ${year}
    order by b.bid_at`)

  // One client is one name on one account: their bids, spends and the furthest stage add up.
  type Client = {
    month: number
    client: string
    service: string
    stage: FunnelStage
    spend: number
    link: string
  }
  const clients = new Map<string, Client>()
  for (const b of r.rows) {
    const key = `${b.account_id}\u0000${b.client.trim().toLowerCase()}`
    const stage = funnelStage(b.stage)
    const c = clients.get(key)
    if (!c) {
      clients.set(key, {
        month: b.month,
        client: b.client || 'без имени',
        service: b.category,
        stage,
        spend: b.spend,
        link: `/leads/${encodeURIComponent(b.lead_id)}`,
      })
      continue
    }
    c.spend += b.spend
    if (RANK[stage] > RANK[c.stage] || (c.stage === 'Отвалился' && stage !== 'Отвалился'))
      c.stage = stage
  }
  const list = [...clients.values()]

  const reached = (s: FunnelStage) =>
    s === 'Отвалился'
      ? list.filter((c) => c.stage === 'Отвалился').length
      : list.filter((c) => c.stage !== 'Отвалился' && RANK[c.stage] >= RANK[s]).length +
        (s === 'Отклик' ? list.filter((c) => c.stage === 'Отвалился').length : 0)
  const bids = list.length
  const funnel = FUNNEL_STAGES.map((stage) => {
    const count = reached(stage)
    return { stage, count, share: pct(count, bids) }
  })

  const months: AnalyticsView['months'] = MONTHS.map((name, i) => {
    const m = list.filter((c) => c.month === i + 1)
    const won = m.filter((c) => c.stage === 'Закрыта').length
    const spend = m.reduce((s, c) => s + c.spend, 0)
    return {
      month: name,
      bids: m.length,
      won,
      lost: m.filter((c) => c.stage === 'Отвалился').length,
      conversion: pct(won, m.length),
      avgCheckRub: null,
      revenueRub: null,
      spendRub: spend,
      cacRub: won > 0 ? Math.round(spend / won) : null,
    }
  })
  const won = list.filter((c) => c.stage === 'Закрыта').length
  const spend = list.reduce((s, c) => s + c.spend, 0)
  months.push({
    month: 'ИТОГО',
    bids,
    won,
    lost: list.filter((c) => c.stage === 'Отвалился').length,
    conversion: pct(won, bids),
    avgCheckRub: null,
    revenueRub: null,
    spendRub: spend,
    cacRub: won > 0 ? Math.round(spend / won) : null,
  })

  return {
    year,
    clients: list.map((c) => ({
      month: MONTHS[c.month - 1] ?? '',
      client: c.client,
      service: c.service,
      stage: c.stage,
      dealRub: null,
      spendRub: c.spend,
      ltvRub: null,
      note: null,
      link: c.link,
    })),
    funnel,
    months,
    notes: [
      'Суммы договоров, выручка, средний чек и LTV появятся с итогами встреч (M6): Сара их пока не знает.',
      'Отклики старой Сары до 24.10 сюда пока не перенесены.',
      'Клиент сейчас это имя на аккаунте: два заказа одного человека с одним именем считаются одним клиентом.',
    ],
  }
}
