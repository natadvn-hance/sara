import { type AnalyticsView, FUNNEL_STAGES, type FunnelStage } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { NOT_TEST } from '../testLeads/sql'
import { stageOf } from './clients'
import { meetingStats } from './meetingStats'

/**
 * Boris's three tables (docs/product/analytics-metrics.md) from what Sara knows today: bids and spends from the
 * journal, stages from the deals and Boris's outcomes. One row is one bid, as in Boris's own log (the platform's
 * client number is not stored yet). The same rows go to his Google Sheet (`sheet/sync.ts`).
 */

export const MONTHS = [
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

export const monthName = (m: number): string => MONTHS[m - 1] ?? ''

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

/**
 * Whether a row at `stage` counts in the funnel line `s` (Boris's sheet «Воронка»: the count runs up, every line a share of
 * the bids). A dropped bid counts in «Отклик» and «Отвалился» only. The pult's tables and the hypotheses of the analytics
 * topic read the funnel through this one function.
 */
export function reachedStage(stage: FunnelStage, s: FunnelStage): boolean {
  if (s === 'Отвалился') return stage === 'Отвалился'
  if (stage === 'Отвалился') return s === 'Отклик'
  return RANK[stage] >= RANK[s]
}

type BidRow = {
  lead_id: string
  account_id: string
  client: string
  title: string
  category: string
  bid_at: string
  month: number
  stage: string | null
  spend: number
  /** The «Стоимость услуги» the bid named: the «от» of its price. */
  quote: number | null
  /** Profi.ru gave the bid's money back: a system line «Вернули на баланс» in the order's chat. */
  refunded: boolean
  /** Boris's outcome of the deal in the pult (pult v2 design 5), the client's note and the service he named. */
  outcome: string | null
  amount_rub: number | null
  service: string | null
  note: string | null
  closed: boolean
}

/** One row of Boris's client log: one bid, as in his own table (one order, one line). */
export type LogRow = {
  orderId: string
  accountId: string
  /** 1..12, the Moscow month of the bid. */
  month: number
  bidAt: string
  client: string
  service: string
  stage: FunnelStage
  /** The contract's sum once won; while the deal goes on or after it dropped, the «от» the bid named. */
  dealRub: number | null
  /** What Profi.ru took for the bid; 0 when it gave the money back. */
  spendRub: number
  ltvRub: number | null
  /** Boris's note on the client; «Вернули на баланс» when Profi.ru gave the bid back and he wrote none. */
  note: string | null
  refunded: boolean
}

/** The service in Boris's short words («Сайт», «Консультация», «Стратегия»); else the order's category. */
const SERVICES: [RegExp, string][] = [
  [/консульт/i, 'Консультация'],
  [/стратег/i, 'Стратегия'],
  [/\bseo\b|сео|продвижение сайт/i, 'SEO'],
  [/сайт|лендинг|тильд|tilda|интернет-магазин/i, 'Сайт'],
  [/директ|контекстн/i, 'Директ'],
  [/таргет/i, 'Таргет'],
  [/авито/i, 'Авито'],
  [/лидоген|привлечени. клиент/i, 'Лидогенерация'],
  [/аудит/i, 'Аудит'],
  [/парс/i, 'Парсинг'],
  [/маркетолог/i, 'Маркетолог'],
]

export function shortService(title: string, category: string): string {
  for (const text of [title, category])
    for (const [re, name] of SERVICES) if (re.test(text)) return name
  return category.trim() || title.trim()
}

export const REFUND_NOTE = 'Вернули на баланс'

/**
 * The client log both the pult and Boris's Google Sheet are made of (one function, so their numbers agree): every bid
 * of the year (Moscow time), or every bid since a moment. A refunded bid has dropped off and cost nothing.
 */
export async function logRows(
  db: DbOrTx,
  of: { year: number } | { since: string },
): Promise<LogRow[]> {
  const when =
    'year' in of
      ? sql`extract(year from b.bid_at at time zone 'Europe/Moscow')::int = ${of.year}`
      : sql`b.bid_at >= ${of.since}::timestamptz`
  const r = await db.execute<BidRow>(sql`
    with b as (
      select entity_id as lead_id, min(occurred_at) as bid_at from core.event
      where type = 'bid.sent' and ${NOT_TEST('entity_id')} group by entity_id
    ), s as (
      select entity_id as lead_id, sum((payload->>'amount_rub')::int)::int as spend from core.event
      where type = 'spend.recorded' and ${NOT_TEST('entity_id')} group by entity_id
    ), r as (
      select distinct m.order_id, m.conversation_id from core.chat_message m
      where m.author = 'system' and m.text ilike '%вернули на баланс%'
    )
    select b.lead_id, l.account_id, l.client_name as client, l.title, l.category, b.bid_at,
      extract(month from b.bid_at at time zone 'Europe/Moscow')::int as month,
      d.stage, coalesce(s.spend, 0)::int as spend,
      coalesce((o.payload->>'servicePriceRub')::int, l.draft_price_rub) as quote,
      exists (select 1 from r where r.order_id = b.lead_id or r.conversation_id = c.id) as refunded,
      c.outcome, c.amount_rub, c.service, c.note, (c.closed_at is not null) as closed
    from b
    join core.lead l on l.id = b.lead_id
    left join core.deal d on d.lead_id = b.lead_id
    left join s on s.lead_id = b.lead_id
    left join core.outbox o on o.kind = 'bid' and o.payload->>'leadId' = b.lead_id
    left join lateral (
      select * from core.conversation cv where cv.order_id = b.lead_id
      order by cv.updated_at desc limit 1
    ) c on true
    where ${when}
    order by b.bid_at, b.lead_id`)
  return r.rows.map((b) => {
    let stage = stageOf({ outcome: b.outcome, closedAt: b.closed ? 'closed' : null }, b.stage)
    if (b.refunded && stage !== 'Закрыта') stage = 'Отвалился'
    const won = stage === 'Закрыта'
    return {
      orderId: b.lead_id,
      accountId: b.account_id,
      month: b.month,
      bidAt: new Date(b.bid_at).toISOString(),
      client: b.client.trim() || 'без имени',
      service: b.service?.trim() || shortService(b.title, b.category),
      stage,
      dealRub: won ? (b.outcome === 'won' ? b.amount_rub : null) : b.quote,
      spendRub: b.refunded ? 0 : b.spend,
      ltvRub: won && b.outcome === 'won' ? b.amount_rub : null,
      note: b.note?.trim() || (b.refunded ? REFUND_NOTE : null),
      refunded: b.refunded,
    }
  })
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null)

export async function analyticsView(db: DbOrTx, year: number): Promise<AnalyticsView> {
  type Client = {
    month: number
    client: string
    service: string
    stage: FunnelStage
    spend: number
    deal: number | null
    ltv: number | null
    note: string | null
    link: string
  }
  const list: Client[] = (await logRows(db, { year })).map((r) => ({
    month: r.month,
    client: r.client,
    service: r.service,
    stage: r.stage,
    spend: r.spendRub,
    deal: r.dealRub,
    ltv: r.ltvRub,
    note: r.note,
    link: `/leads/${encodeURIComponent(r.orderId)}`,
  }))

  const reached = (s: FunnelStage) => list.filter((c) => reachedStage(c.stage, s)).length
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
      month: monthName(c.month),
      client: c.client,
      service: c.service,
      stage: c.stage,
      dealRub: c.deal,
      spendRub: c.spend,
      ltvRub: c.ltv,
      note: c.note,
      link: c.link,
    })),
    funnel,
    months,
    meetings: await meetingStats(db, year),
    notes: [
      ...(unpriced
        ? [
            `Сумма договора не названа у ${unpriced}: они в «Закрытых сделках», но не в среднем чеке.`,
          ]
        : []),
      'Договор и сумму записывает Борис на экране клиента или в итоге встречи; LTV пока равен сумме договоров, продления появятся позже.',
      'Отклики старой Сары до 24.10 сюда пока не перенесены.',
      'Одна строка это один отклик, как в таблице Бориса: два заказа одного человека это две строки. Сумма сделки до договора это «от» из отклика.',
    ],
  }
}
