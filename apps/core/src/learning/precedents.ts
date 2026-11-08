import { leadKind } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { isReasonCode, type Reason, reasonText } from './reasons'

/**
 * Boris's own decisions on orders like this one (07.11.2026): the Scorer sees them as examples, so it learns from his
 * presses at once, without a rule change (docs/superpowers/specs/2026-11-07-learn-from-closes.md).
 */
export type Precedent = {
  leadId: string
  title: string
  category: string
  /** For the gateway to hide, never shown. */
  clientName: string
  label: 'yes' | 'no'
  reason: Reason | null
  /** Boris chose the reason himself; false: Sara's guess he left. */
  chosen: boolean
}

/** As `lead_score.precedents` keeps them: what the card needs, no titles or names. */
export type StoredPrecedents = {
  items: { id: string; label: 'yes' | 'no'; code: string | null; detail: string | null }[]
}

/** At most this many decisions go into one score. */
export const PRECEDENTS_MAX = 5
/** Only his decisions of the last 90 days: the rules and his taste move. */
const WINDOW_DAYS = 90
/** How many recent decisions are looked through for the similar ones. */
const POOL = 400
/** A decision this similar or more counts (the same category alone is 0.3). */
const MIN_SIMILAR = 0.3

const STOP = new Set(
  (
    'для что как это или все при без под над про мне нам наш так уже еще его она они был нет год ' +
    'нужен нужна нужно нужны чтобы который которая которые компании компания услуги услуга помощь ' +
    'специалист специалиста требуется ищу ищем сделать заказ работа работы проект нашей нашего наших ' +
    'есть будет можно очень просто также свой свою своих'
  ).split(' '),
)

/** The stems of the words that carry meaning: lower case, ё as е, short and common words out, the first 6 letters. */
export function stems(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue
    out.add(w.slice(0, 6))
  }
  return out
}

const cosine = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 || b.size === 0) return 0
  let common = 0
  for (const w of a) if (b.has(w)) common++
  return common / Math.sqrt(a.size * b.size)
}

type Order = { title: string; category: string; text: string }

/** How alike two orders are, 0 to about 1.2: the title and category words most, the text's start, the same category. */
export function similarity(a: Order, b: Order): number {
  const sameCategory = a.category.trim().toLowerCase() === b.category.trim().toLowerCase()
  return (
    0.6 * cosine(stems(`${a.title} ${a.category}`), stems(`${b.title} ${b.category}`)) +
    0.25 * cosine(stems(a.text.slice(0, 400)), stems(b.text.slice(0, 400))) +
    (sameCategory ? 0.25 : 0) +
    (leadKind(a.category) === leadKind(b.category) ? 0.05 : 0)
  )
}

type Row = {
  id: string
  title: string
  category: string
  text: string
  client_name: string
  label: 'yes' | 'no'
  reason_code: string | null
  reason_detail: string | null
  reason_by: string | null
}

/**
 * Up to five orders like this one that Boris decided himself (a bid or a close; an ignored card is no decision), the
 * most alike first. Without the order itself.
 */
export async function similarDecisions(
  db: DbOrTx,
  accountId: string,
  o: Order & { orderId: string },
  now = new Date(),
): Promise<Precedent[]> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString()
  const r = await db.execute<Row>(sql`
    select l.id, l.title, l.category, left(l.text, 400) as text, l.client_name, b.label,
      b.reason_code, b.reason_detail, b.reason_by
    from core.lead_label b
    join core.lead l on l.id = b.lead_id
    where l.account_id = ${accountId} and b.label in ('yes', 'no') and l.id <> ${o.orderId}
      and b.at > ${since}::timestamptz
    order by b.at desc
    limit ${POOL}`)
  return r.rows
    .map((row, i) => ({ row, i, sim: similarity(o, row) }))
    .filter((x) => x.sim >= MIN_SIMILAR)
    .sort((a, b) => b.sim - a.sim || a.i - b.i)
    .slice(0, PRECEDENTS_MAX)
    .map(({ row }) => ({
      leadId: row.id,
      title: row.title,
      category: row.category,
      clientName: row.client_name,
      label: row.label,
      reason:
        row.label === 'no' && isReasonCode(row.reason_code)
          ? { code: row.reason_code, detail: row.reason_detail }
          : null,
      chosen: row.reason_by === 'boris',
    }))
}

/** The block of the Scorer's input; empty when there are none. */
export function precedentsText(ps: Precedent[]): string {
  if (ps.length === 0) return ''
  const line = (p: Precedent) => {
    const what = `«${p.title.trim()}» (${p.category.trim()})`
    if (p.label === 'yes') return `- ${what}: откликнулся`
    if (!p.reason) return `- ${what}: закрыл`
    return `- ${what}: закрыл, ${p.chosen ? 'причина' : 'похоже'}: ${reasonText(p.reason)}`
  }
  return [
    'Решения Бориса по похожим заказам (его прошлые нажатия, самые похожие первыми):',
    ...ps.map(line),
  ].join('\n')
}

export const storePrecedents = (ps: Precedent[]): StoredPrecedents => ({
  items: ps.map((p) => ({
    id: p.leadId,
    label: p.label,
    code: p.reason?.code ?? null,
    detail: p.reason?.detail ?? null,
  })),
})

/** What the card says of them: how many of the similar he closed or bid on, and his most frequent reason. */
export type SimilarOnCard = { n: number; closed: number; bid: number; reason: string | null }

export function similarOnCard(stored: unknown): SimilarOnCard | null {
  const items = (stored as Partial<StoredPrecedents> | null)?.items
  if (!Array.isArray(items) || items.length < 2) return null
  const closed = items.filter((i) => i.label === 'no')
  const counts = new Map<string, number>()
  for (const i of closed) {
    if (!isReasonCode(i.code) || i.code === 'other') continue
    // The card names the reason without its detail: «не наш профиль», not each kind of it.
    const t = reasonText({ code: i.code, detail: null })
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return {
    n: items.length,
    closed: closed.length,
    bid: items.length - closed.length,
    // A reason only when it stands behind at least half of his closes.
    reason: top && top[1] * 2 >= closed.length ? top[0] : null,
  }
}
