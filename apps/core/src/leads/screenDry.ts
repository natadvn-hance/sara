import { ClientInfo, SCREEN_CRITERIA, SCREEN_RU, type ScreenCriterion } from '@sara/shared'
import {
  type Check,
  type FormParts,
  negativeReviews,
  newAccount,
  ownWords,
  shortText,
  vacancy,
  vacancySoft,
} from './screen'

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
  /** Orders that look like a vacancy but are not stopped: they lose points. */
  soft: { n: number; shown: number; bid: number }
  /** A thin text with a form that says something: loses points, is not stopped (31.10.2026). */
  softText: Count
  /** What the old short_text rule (own words below the threshold stop) would have stopped, for the comparison. */
  legacyText: Count
  /** The orders stopped with the old rule, counted with the other criteria as before. */
  legacyOut: Count
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
    soft: zero(),
    softText: zero(),
    legacyText: zero(),
    legacyOut: zero(),
    lost: [],
  }
  for (const r of rows) {
    const info = ClientInfo.safeParse(r.clientInfo).data ?? null
    const checks: Check[] = [
      newAccount(info, new Date(r.seenAt)),
      negativeReviews(info),
      shortText(r, form, minWords),
      vacancy(r),
    ]
    const hits = checks.flatMap((c) => ('hit' in c ? [c.hit.criterion] : []))
    for (const c of checks) if ('noData' in c) res.noData[c.noData]++
    for (const h of hits) add(res.by[h], r)
    for (const c of checks) if ('soft' in c) add(res.softText, r)
    const oldText = r.text.trim() !== '' && ownWords(r, form).length < minWords
    if (oldText) add(res.legacyText, r)
    if (oldText || hits.some((h) => h !== 'short_text')) add(res.legacyOut, r)
    if (hits.length === 0 && vacancySoft(r)) add(res.soft, r)
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
  for (const c of ['new_account', 'negative_reviews', 'short_text', 'vacancy'] as const) {
    const b = r.by[c]
    lines.push(
      `- ${SCREEN_RU[c]}: ${b.n}, показанных ${b.shown}, с откликом ${b.bid}; нет данных у ${r.noData[c]}`,
    )
  }
  lines.push(
    `- Похоже на вакансию, теряют баллы: ${r.soft.n}, показанных ${r.soft.shown}, с откликом ${r.soft.bid}`,
    `- Мало слов клиента, но анкета заполнена, теряют 5 баллов: ${r.softText.n}, показанных ${r.softText.shown}, с откликом ${r.softText.bid}`,
    '',
    `До смягчения (короткий текст останавливал): остановил бы ${r.legacyOut.n} (${pct(r.legacyOut.n, r.orders)}), из них короткий текст ${r.legacyText.n}, показанных ${r.legacyOut.shown}, с откликом ${r.legacyOut.bid}`,
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
