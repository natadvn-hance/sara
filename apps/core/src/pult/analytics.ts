import { type AnalyticsView, FUNNEL_STAGES, type FunnelStage } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { stageOf } from './clients'
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
  /** Boris's outcome of the deal in the pult (pult v2 design 5), the client's note and the service he named. */
  outcome: string | null
  amount_rub: number | null
  service: string | null
  note: string | null
  closed: boolean
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
      d.stage, coalesce(s.spend, 0)::int as spend,
      c.outcome, c.amount_rub, c.service, c.note, (c.closed_at is not null) as closed
    from b
    join core.lead l on l.id = b.lead_id
    left join core.deal d on d.lead_id = b.lead_id
    left join s on s.lead_id = b.lead_id
    left join lateral (
      select * from core.conversation cv where cv.order_id = b.lead_id
      order by cv.updated_at desc limit 1
    ) c on true
    where extract(year from b.bid_at at time zone 'Europe/Moscow')::int = ${year}
    order by b.bid_at`)

  // One client is one name on one account: their bids, spends and the furthest stage add up.
  type Client = {
    month: number
    client: string
    service: string
    stage: FunnelStage
    spend: number
    deal: number | null
    note: string | null
    link: string
  }
  const clients = new Map<string, Client>()
  for (const b of r.rows) {
    const key = `${b.account_id}\u0000${b.client.trim().toLowerCase()}`
    const stage = stageOf({ outcome: b.outcome, closedAt: b.closed ? 'closed' : null }, b.stage)
    const c = clients.get(key)
    if (!c) {
      clients.set(key, {
        month: b.month,
        client: b.client || 'без имени',
        service: b.service ?? b.category,
        stage,
        spend: b.spend,
        deal: b.outcome === 'won' ? b.amount_rub : null,
        note: b.note,
        link: `/leads/${encodeURIComponent(b.lead_id)}`,
      })
      continue
    }
    c.spend += b.spend
    if (b.outcome === 'won' && b.amount_rub !== null) c.deal = (c.deal ?? 0) + b.amount_rub
    if (b.note) c.note = b.note
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

  /** Revenue and the average check count only contracts with a sum (analytics-metrics.md, section 4). */
  const money = (m: Client[]) => {
    const won = m.filter((c) => c.stage === 'Закрыта')
    const priced = won.filter((c) => c.deal !== null)
    const revenue = priced.reduce((s, c) => s + (c.deal ?? 0), 0)
    const spend = m.reduce((s, c) => s + c.spend, 0)
    return {
      bids: m.length,
      won: won.length,
      lost: m.filter((c) => c.stage === 'Отвалился').length,
      conversion: pct(won.length, m.length),
      avgCheckRub: priced.length ? Math.round(revenue / priced.length) : null,
      revenueRub: priced.length ? revenue : null,
      spendRub: spend,
      cacRub: won.length > 0 ? Math.round(spend / won.length) : null,
    }
  }
  const months: AnalyticsView['months'] = MONTHS.map((name, i) => ({
    month: name,
    ...money(list.filter((c) => c.month === i + 1)),
  }))
  months.push({ month: 'ИТОГО', ...money(list) })
  const unpriced = list.filter((c) => c.stage === 'Закрыта' && c.deal === null).length

  return {
    year,
    clients: list.map((c) => ({
      month: MONTHS[c.month - 1] ?? '',
      client: c.client,
      service: c.service,
      stage: c.stage,
      dealRub: c.deal,
      spendRub: c.spend,
      ltvRub: c.deal,
      note: c.note,
      link: c.link,
    })),
    funnel,
    months,
    notes: [
      ...(unpriced
        ? [
            `Сумма договора не названа у ${unpriced}: они в «Закрытых сделках», но не в среднем чеке.`,
          ]
        : []),
      'Договор и сумму записывает Борис на экране клиента или в итоге встречи; LTV пока равен сумме договоров, продления появятся позже.',
      'Отклики старой Сары до 24.10 сюда пока не перенесены.',
      'Клиент сейчас это имя на аккаунте: два заказа одного человека с одним именем считаются одним клиентом.',
    ],
  }
}
