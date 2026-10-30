import { ClientInfo, SCREEN_CRITERIA, SCREEN_RU, type ScreenCriterion } from '@sara/shared'
import { type Check, type FormParts, negativeReviews, newAccount, shortText } from './screen'

/**
 * The screen's criteria 1-3 over orders already seen, to check it on real data before it stops anything
 * (docs/product/lead-analysis.md). Criteria 4-6 need the Sorter and are not run here. Only numbers and order ids come
 * out, never the client's words.
 */

export type DryRow = {
  id: string
  title: string
  text: string
  clientInfo: unknown
  seenAt: string
  /** A card went to Boris (a decision task). */
  shown: boolean
  /** A bid went out. */
  bid: boolean
}

type Count = { n: number; shown: number; bid: number }
export type DryResult = {
  orders: number
  shown: number
  bid: number
  out: Count
  by: Record<ScreenCriterion, Count>
  noData: Record<ScreenCriterion, number>
  /** The shown or bid orders the screen would stop: Boris checks these by hand. */
  lost: { id: string; criteria: ScreenCriterion[]; shown: boolean; bid: boolean }[]
}

const zero = (): Count => ({ n: 0, shown: 0, bid: 0 })
const add = (c: Count, r: DryRow) => {
  c.n++
  if (r.shown) c.shown++
  if (r.bid) c.bid++
}

export function dryScreen(rows: DryRow[], form: FormParts, minWords: number): DryResult {
  const res: DryResult = {
    orders: rows.length,
    shown: rows.filter((r) => r.shown).length,
    bid: rows.filter((r) => r.bid).length,
    out: zero(),
    by: Object.fromEntries(SCREEN_CRITERIA.map((c) => [c, zero()])) as DryResult['by'],
    noData: Object.fromEntries(SCREEN_CRITERIA.map((c) => [c, 0])) as DryResult['noData'],
    lost: [],
  }
  for (const r of rows) {
    const info = ClientInfo.safeParse(r.clientInfo).data ?? null
    const checks: Check[] = [
      newAccount(info, new Date(r.seenAt)),
      negativeReviews(info),
      shortText(r, form, minWords),
    ]
    const hits = checks.flatMap((c) => ('hit' in c ? [c.hit.criterion] : []))
    for (const c of checks) if ('noData' in c) res.noData[c.noData]++
    for (const h of hits) add(res.by[h], r)
    if (hits.length === 0) continue
    add(res.out, r)
    if (r.shown || r.bid) res.lost.push({ id: r.id, criteria: hits, shown: r.shown, bid: r.bid })
  }
  return res
}

const pct = (a: number, b: number) => (b === 0 ? '0%' : `${Math.round((100 * a) / b)}%`)

export function dryReport(r: DryResult, minWords: number): string {
  const lines = [
    `Заказов: ${r.orders}, показано Борису: ${r.shown}, откликов: ${r.bid}`,
    `Отсев по критериям 1-3 (порог своих слов ${minWords}) остановил бы ${r.out.n} (${pct(r.out.n, r.orders)}), из них показанных ${r.out.shown}, с откликом ${r.out.bid}`,
    '',
    'По критериям (заказ может попасть в несколько):',
  ]
  for (const c of SCREEN_CRITERIA.slice(0, 3)) {
    const b = r.by[c]
    lines.push(
      `- ${SCREEN_RU[c]}: ${b.n}, показанных ${b.shown}, с откликом ${b.bid}; нет данных у ${r.noData[c]}`,
    )
  }
  lines.push(
    '',
    'Критерии 4-6 (Директ, WordPress, точечные правки) решает Сортировщик, здесь их нет.',
  )
  if (r.lost.length > 0) {
    lines.push('', 'Показанные или с откликом, которые отсев остановил бы (проверить руками):')
    for (const l of r.lost)
      lines.push(
        `- ${l.id}: ${l.criteria.map((c) => SCREEN_RU[c]).join(', ')}${l.bid ? ', был отклик' : l.shown ? ', была карточка' : ''}`,
      )
  }
  return lines.join('\n')
}
