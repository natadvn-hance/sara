import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { type FormParts, loadFormParts, ownText } from '../leads/screen'
import { isReasonCode, type Reason, reasonText } from './reasons'

/**
 * Boris's own decisions on orders like this one (07.11.2026): the Scorer sees them as examples, so it learns from his
 * presses at once, without a rule change (docs/superpowers/specs/2026-11-07-learn-from-closes.md). Since 10.11.2026 up
 * to 15 of them, and only those that share the client's words, not the category alone
 * (docs/superpowers/specs/2026-11-10-shadow-autobid.md).
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

/** At most this many decisions go into one score and the card's share (Boris, 10.11.2026: 10-15, not 5). */
export const PRECEDENTS_MAX = 15
/** Only his decisions of the last 90 days: the rules and his taste move. */
export const WINDOW_DAYS = 90
/** How many recent decisions are looked through for the similar ones. */
export const POOL = 400
/**
 * How alike, 0 to 1, two orders must be to count (the weighted cosine below). Chosen on 981 real orders of September
 * 2026: of pairs from 0.2 up about 7 in 12 were the same task, from 0.15 to 0.2 only 4-5 in 12 (the spec, section 1).
 */
export const MIN_SIMILAR = 0.2
/** ...and how many words of the clients' own texts they must share, not counting the common ones. */
export const MIN_SHARED_WORDS = 2
/** A word in more than this share of the orders of the last month («клиент», «реклама») is common: it proves nothing... */
const COMMON_SHARE = 0.1
/** ...when it is in more than this many of them too: in a young database nothing is common yet. */
const COMMON_MIN_ORDERS = 20
/** The orders of how many last days the words are counted in, and how long the count is kept. */
const STATS_DAYS = 30
const STATS_TTL_MS = 3600 * 1000
/** How much of the client's own text is read: its start says what the order is about. */
const OWN_TEXT_CHARS = 600

const STOP = new Set(
  (
    'для что как это или все при без под над про мне нам наш так уже еще его она они был нет год ' +
    'нужен нужна нужно нужны чтобы который которая которые компании компания услуги услуга помощь ' +
    'специалист специалиста требуется ищу ищем сделать заказ работа работы проект нашей нашего наших ' +
    'есть будет можно очень просто также свой свою своих добрый день здравствуйте привет вечер утро спасибо'
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

type Order = { title: string; category: string; text: string }

/** The words an order is compared by: of its title and category, and of the client's own text (no site form). */
export type Words = { all: Set<string>; own: Set<string> }

export function wordsOf(o: Order, form: FormParts): Words {
  const own = stems(ownText(o.text, form).slice(0, OWN_TEXT_CHARS))
  const head = stems(o.title.trim() === o.category.trim() ? o.title : `${o.title} ${o.category}`)
  return { own, all: new Set([...head, ...own]) }
}

/** In how many orders each word is: of all orders seen, not only his decisions, so a topic he often decides stays rare. */
export type WordStats = { n: number; df: Map<string, number> }

export function statsOf(docs: Iterable<Words>): WordStats {
  const df = new Map<string, number>()
  let n = 0
  for (const d of docs) {
    n++
    for (const w of d.all) df.set(w, (df.get(w) ?? 0) + 1)
  }
  return { n, df }
}

let counted: { at: number; stats: WordStats } | null = null

/** The words of the orders of the last month, counted in the core and kept for an hour (as the site's form is). */
export async function loadWordStats(
  db: DbOrTx,
  form: FormParts,
  now = Date.now(),
): Promise<WordStats> {
  if (counted && now - counted.at < STATS_TTL_MS) return counted.stats
  const r = await db.execute<Order>(sql`
    select title, category, left(text, 2000) as text from core.lead
    where seen_at > now() - make_interval(days => ${STATS_DAYS}::int)`)
  const stats = statsOf(r.rows.map((o) => wordsOf(o, form)))
  counted = { at: now, stats }
  return stats
}

/** Tests start from an empty count. */
export function forgetWordStats(): void {
  counted = null
}

/**
 * The weight of each word: a rare word weighs more than one in many orders (the category's name, «продвижение»), so
 * the title alone, which on Profi.ru is the category, makes no orders alike.
 */
export type Weights = { weight: (w: string) => number; common: (w: string) => boolean }

export function weightsOf({ n, df }: WordStats): Weights {
  const most = Math.max(COMMON_MIN_ORDERS, COMMON_SHARE * n)
  return {
    weight: (w) => Math.log((n + 1) / ((df.get(w) ?? 0) + 1)) + 1,
    common: (w) => (df.get(w) ?? 0) > most,
  }
}

/** How alike two orders are (the weighted cosine of their words, 0 to 1) and how many own words they share. */
export function similarity(a: Words, b: Words, w: Weights): { score: number; shared: number } {
  let dot = 0
  let na = 0
  let nb = 0
  for (const x of a.all) {
    const k = w.weight(x) ** 2
    na += k
    if (b.all.has(x)) dot += k
  }
  for (const x of b.all) nb += w.weight(x) ** 2
  let shared = 0
  for (const x of a.own) if (b.own.has(x) && !w.common(x)) shared++
  return { score: na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0, shared }
}

/** Similar enough to count: alike by the weights and sharing the client's words. */
export const alike = (s: { score: number; shared: number }) =>
  s.score >= MIN_SIMILAR && s.shared >= MIN_SHARED_WORDS

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
 * Up to 15 orders like this one that Boris decided himself (a bid or a close; an ignored card is no decision), the
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
    select l.id, l.title, l.category, left(l.text, 2000) as text, l.client_name, b.label,
      b.reason_code, b.reason_detail, b.reason_by
    from core.lead_label b
    join core.lead l on l.id = b.lead_id
    where l.account_id = ${accountId} and b.label in ('yes', 'no') and l.id <> ${o.orderId}
      and b.at > ${since}::timestamptz
    order by b.at desc
    limit ${POOL}`)
  if (r.rows.length === 0) return []
  const form = await loadFormParts(db)
  const w = weightsOf(await loadWordStats(db, form))
  const mine = wordsOf(o, form)
  const theirs = r.rows.map((row) => wordsOf(row, form))
  return r.rows
    .map((row, i) => ({ row, i, s: similarity(mine, theirs[i] as Words, w) }))
    .filter((x) => alike(x.s))
    .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
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

/** How often he bid on the similar ones, as the card and the Scorer both say it. */
export type Share = { n: number; bid: number; pct: number; enough: boolean }

/** The share of bids among `n` similar decisions; below `min` of them it is too few to count. */
export function shareOf(labels: ('yes' | 'no')[], min: number): Share {
  const n = labels.length
  const bid = labels.filter((l) => l === 'yes').length
  return { n, bid, pct: n > 0 ? Math.round((bid * 100) / n) : 0, enough: n >= min }
}

/**
 * The block of the Scorer's input; empty when there are none. Its first line says the share as the card does: with
 * fewer than `min` decisions it is said to be too few.
 */
export function precedentsText(ps: Precedent[], min = 10): string {
  if (ps.length === 0) return ''
  const line = (p: Precedent) => {
    const what = `«${p.title.trim()}» (${p.category.trim()})`
    if (p.label === 'yes') return `- ${what}: откликнулся`
    if (!p.reason) return `- ${what}: закрыл`
    return `- ${what}: закрыл, ${p.chosen ? 'причина' : 'похоже'}: ${reasonText(p.reason)}`
  }
  const s = shareOf(
    ps.map((p) => p.label),
    min,
  )
  const share = s.enough
    ? `откликнулся на ${s.bid} из ${s.n}, это ${s.pct}%`
    : `откликнулся на ${s.bid} из ${s.n}; похожих меньше ${min}, доля ещё ничего не говорит`
  return [
    `Решения Бориса по похожим заказам (его прошлые нажатия, самые похожие первыми): ${share}.`,
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

/** What the card says of them: the share of bids, how many he closed, and his most frequent reason for closing. */
export type SimilarOnCard = Share & { min: number; closed: number; reason: string | null }

export function similarOnCard(stored: unknown, min: number): SimilarOnCard | null {
  const items = (stored as Partial<StoredPrecedents> | null)?.items
  if (!Array.isArray(items) || items.length === 0) return null
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
    ...shareOf(
      items.map((i) => (i.label === 'yes' ? 'yes' : 'no')),
      min,
    ),
    min,
    closed: closed.length,
    // A reason only when it stands behind at least half of his closes.
    reason: top && top[1] * 2 >= closed.length ? top[0] : null,
  }
}
