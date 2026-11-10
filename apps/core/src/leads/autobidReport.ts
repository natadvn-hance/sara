import { isTestOrder } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import {
  alike,
  loadWordStats,
  POOL,
  PRECEDENTS_MAX,
  similarity,
  WINDOW_DAYS,
  type Words,
  weightsOf,
  wordsOf,
} from '../learning/precedents'
import { AUTOBID_MISSES, type AutobidMiss, type AutobidRule, wouldBid } from './autobidShadow'
import { loadFormParts } from './screen'

/**
 * How the shadow of the auto-bid agrees with Boris (docs/superpowers/specs/2026-11-10-shadow-autobid.md, section 3):
 * the marked cards he bid on or closed himself, the unmarked ones he bid on; and the rule as if it had stood over his
 * past decisions. Numbers and order counts only, never the client's words. `pnpm report:autobid` prints it.
 */

/** What Boris did with a card: bid, closed, let it go stale, or nothing yet. */
export type Outcome = 'bid' | 'closed' | 'stale' | 'waiting'
const outcomeOf = (label: string | null): Outcome =>
  label === 'yes' ? 'bid' : label === 'no' ? 'closed' : label === 'weak_no' ? 'stale' : 'waiting'

/** One card's shadow as journaled, with what Boris did. */
export type ShadowRow = {
  leadId: string
  would: boolean
  misses: AutobidMiss[]
  n: number
  bid: number
  feeRub: number | null
  feeFromPage: boolean
  rule: AutobidRule
  outcome: Outcome
}

type Count = Record<Outcome, number> & { n: number }
const zero = (): Count => ({ n: 0, bid: 0, closed: 0, stale: 0, waiting: 0 })

export type WeekReport = {
  days: number
  cards: number
  marked: Count
  unmarked: Count
  /** Of the cards he decided (bid or closed): marked and bid, or unmarked and closed. */
  agree: number
  decided: number
  /** Why the unmarked were not marked; a card may have several reasons. */
  misses: Record<AutobidMiss, number>
  /** What another minimum of similar orders would have marked, all else as journaled. */
  byMin: { min: number; marked: Count }[]
}

export const OTHER_MINIMUMS = [5, 7, 10, 12]

export function weekReport(rows: ShadowRow[], days: number): WeekReport {
  const marked = zero()
  const unmarked = zero()
  const misses = Object.fromEntries(AUTOBID_MISSES.map((m) => [m, 0])) as Record<
    AutobidMiss,
    number
  >
  let agree = 0
  let decided = 0
  for (const r of rows) {
    const c = r.would ? marked : unmarked
    c.n++
    c[r.outcome]++
    if (!r.would) for (const m of r.misses) misses[m]++
    if (r.outcome === 'bid' || r.outcome === 'closed') {
      decided++
      if (r.would === (r.outcome === 'bid')) agree++
    }
  }
  const byMin = OTHER_MINIMUMS.map((min) => {
    const c = zero()
    for (const r of rows) {
      const fee = { rub: r.feeRub ?? 0, fromPage: r.feeFromPage }
      if (!wouldBid({ n: r.n, bid: r.bid }, fee, { ...r.rule, minSimilar: min }).would) continue
      c.n++
      c[r.outcome]++
    }
    return { min, marked: c }
  })
  return { days, cards: rows.length, marked, unmarked, agree, decided, misses, byMin }
}

type EventRow = {
  lead_id: string
  payload: Record<string, unknown>
  label: string | null
}

/** The shadows journaled in the last `days` days, test orders aside, with Boris's decision on each. */
export async function loadShadows(
  db: DbOrTx,
  days: number,
  now = new Date(),
): Promise<ShadowRow[]> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString()
  const r = await db.execute<EventRow>(sql`
    select distinct on (e.entity_id) e.entity_id as lead_id, e.payload, b.label
    from core.event e
    left join core.lead_label b on b.lead_id = e.entity_id
    where e.type = 'lead.autobid_shadow' and e.occurred_at > ${since}::timestamptz
    order by e.entity_id, e.occurred_at`)
  const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d)
  return r.rows
    .filter((row) => !isTestOrder(row.lead_id))
    .map((row) => {
      const p = row.payload
      return {
        leadId: row.lead_id,
        would: p.would === true,
        misses: (Array.isArray(p.misses) ? p.misses : []).filter((m): m is AutobidMiss =>
          (AUTOBID_MISSES as readonly string[]).includes(m as string),
        ),
        n: num(p.n, 0),
        bid: num(p.bid, 0),
        feeRub: typeof p.fee_rub === 'number' ? p.fee_rub : null,
        feeFromPage: p.fee_from_page === true,
        rule: {
          minSimilar: num(p.min_similar, 10),
          minSharePct: num(p.min_share_pct, 80),
          maxFeeRub: typeof p.max_fee_rub === 'number' ? p.max_fee_rub : null,
        },
        outcome: outcomeOf(row.label),
      }
    })
}

/** The rule over Boris's past decisions: what it would have said had it stood then. */
export type HistoryReport = {
  days: number
  decisions: number
  /** His decisions by how many similar earlier decisions they had: none, 1-4, 5-9, 10 and more. */
  bySimilar: { none: number; few: number; some: number; enough: number }
  /** His bids among the decisions. */
  bids: number
  byMin: { min: number; fired: number; bid: number; closed: number }[]
}

type Decision = {
  id: string
  title: string
  category: string
  text: string
  label: 'yes' | 'no'
  at: string | Date
  fee: number
}

/**
 * Each of his decisions of the last `days` days against his decisions before it (90 days back, the newest 400, the
 * 15 most alike), the same way a new card is. The price's freshness is not known for the past: a price above 0 counts.
 */
export async function historyReport(
  db: DbOrTx,
  accountId: string,
  rule: AutobidRule,
  days: number,
  now = new Date(),
): Promise<HistoryReport> {
  const since = new Date(now.getTime() - (days + WINDOW_DAYS) * 86_400_000).toISOString()
  const r = await db.execute<Decision>(sql`
    select l.id, l.title, l.category, left(l.text, 2000) as text, b.label, b.at, l.bid_price_rub as fee
    from core.lead_label b join core.lead l on l.id = b.lead_id
    where l.account_id = ${accountId} and b.label in ('yes', 'no') and b.at > ${since}::timestamptz
    order by b.at`)
  const form = await loadFormParts(db)
  const w = weightsOf(await loadWordStats(db, form))
  // The driver may give the time as a Date or a string.
  const all = r.rows.map((d) => ({ d, words: wordsOf(d, form), at: new Date(d.at).getTime() }))
  const from = now.getTime() - days * 86_400_000
  const out: HistoryReport = {
    days,
    decisions: 0,
    bySimilar: { none: 0, few: 0, some: 0, enough: 0 },
    bids: 0,
    byMin: [...new Set([...OTHER_MINIMUMS, rule.minSimilar])]
      .sort((a, b) => a - b)
      .map((min) => ({ min, fired: 0, bid: 0, closed: 0 })),
  }
  all.forEach((x, i) => {
    if (x.at <= from) return
    const pool = all
      .slice(0, i)
      .filter((p) => p.at > x.at - WINDOW_DAYS * 86_400_000)
      .slice(-POOL)
      .reverse()
    const labels = pool
      .map((p, k) => ({ p, k, s: similarity(x.words, p.words as Words, w) }))
      .filter((s) => alike(s.s))
      .sort((a, b) => b.s.score - a.s.score || a.k - b.k)
      .slice(0, PRECEDENTS_MAX)
      .map((s) => s.p.d.label)
    const n = labels.length
    out.decisions++
    if (x.d.label === 'yes') out.bids++
    const band = n === 0 ? 'none' : n < 5 ? 'few' : n < 10 ? 'some' : 'enough'
    out.bySimilar[band]++
    const similar = { n, bid: labels.filter((l) => l === 'yes').length }
    for (const m of out.byMin) {
      if (
        !wouldBid(similar, { rub: x.d.fee, fromPage: true }, { ...rule, minSimilar: m.min }).would
      )
        continue
      m.fired++
      if (x.d.label === 'yes') m.bid++
      else m.closed++
    }
  })
  return out
}

const MISS_RU: Record<AutobidMiss, string> = {
  few_similar: 'мало похожих',
  low_share: 'мало откликов на похожие',
  fee_unknown: 'цена отклика неизвестна',
  fee_not_fresh: 'цена не со страницы',
  fee_high: 'дороже потолка',
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a * 100) / b)}%` : 'нет решений')
const what = (c: Count) =>
  `ты откликнулся на ${c.bid}, закрыл ${c.closed}, пропустил ${c.stale}, ещё не решил ${c.waiting}`

/** The report as one plain message (Russian, no long dash, numbers only). */
export function reportText(
  week: WeekReport,
  history: HistoryReport | null,
  rule: AutobidRule,
): string {
  const lines = [
    `Тень автоотклика за ${week.days} дн.: правило «на похожие откликался больше ${rule.minSharePct}%, похожих не меньше ${rule.minSimilar}, отклик не дороже ${rule.maxFeeRub ?? 'любой цены'}${rule.maxFeeRub === null ? '' : ' ₽'}». Карточек с проверкой: ${week.cards}.`,
    `🤖 Помечено ${week.marked.n}: ${what(week.marked)}.`,
    `Без пометки ${week.unmarked.n}: ${what(week.unmarked)}.`,
    `Совпадение с тобой: ${week.agree} из ${week.decided} решённых (${pct(week.agree, week.decided)}).`,
  ]
  const why = AUTOBID_MISSES.filter((m) => week.misses[m] > 0).map(
    (m) => `${MISS_RU[m]} ${week.misses[m]}`,
  )
  if (why.length > 0) lines.push(`Почему без пометки: ${why.join(', ')}.`)
  lines.push(
    `С другим минимумом похожих: ${week.byMin
      .map(
        (b) =>
          `${b.min}: помечено ${b.marked.n} (откликнулся ${b.marked.bid}, закрыл ${b.marked.closed})`,
      )
      .join('; ')}.`,
  )
  if (history) {
    const s = history.bySimilar
    lines.push(
      '',
      `По истории твоих решений за ${history.days} дн., как будто правило стояло тогда (свежесть цены в прошлом не проверить): решений ${history.decisions}, из них откликов ${history.bids}.`,
      `Похожих решений до каждого: 10 и больше у ${s.enough}, от 5 до 9 у ${s.some}, от 1 до 4 у ${s.few}, ни одного у ${s.none}.`,
      ...history.byMin.map(
        (m) =>
          `Минимум ${m.min}: сработало бы на ${m.fired}, из них ты откликнулся на ${m.bid}, закрыл ${m.closed}; поймало бы ${m.bid} из ${history.bids} твоих откликов.`,
      ),
    )
  }
  return lines.join('\n')
}
