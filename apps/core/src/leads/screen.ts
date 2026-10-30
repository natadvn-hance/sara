import {
  type ClientInfo,
  type LeadScreen,
  plural,
  SCREEN_CRITERIA,
  SCREEN_RU,
  type ScreenCriterion,
  type ScreenMark,
  type SorterOutput,
} from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'

/**
 * Stage 1 «Отсев» (Boris, 30.10.2026, docs/product/lead-analysis.md): an order is stopped only by facts, before any
 * reading of it. Criteria 1-3 are the code's (the profile, the count of the client's own words), 4-6 the Sorter's
 * (the sense of the task, with a quote that must be in the order). No data, no stop; a doubt goes the order's way.
 */

/** A part of the order text is the site's form when it is repeated word for word in this many orders. */
export const FORM_MIN_ORDERS = 3
/** How far back the orders are read to learn the form, and how long what was learned is kept. */
const FORM_DAYS = 30
const FORM_TTL_MS = 3600 * 1000

/** What the site's order form writes: whole parts («Лендинг», «Платформа: по рекомендации специалиста») and labels. */
export type FormParts = { parts: Set<string>; labels: Set<string> }

const space = (s: string) => s.trim().replace(/\s+/g, ' ')
/** How parts are compared: case, ё and a closing period aside (the page ends its lines with one, the board not). */
const key = (s: string) =>
  space(s)
    .replace(/[.;,]+$/, '')
    .toLowerCase()
    .replace(/ё/g, 'е')

/** The parts of an order text: the board joins the form's answers with « · », the page puts them on lines. */
export function splitParts(text: string): string[] {
  return text
    .split(/\s+·\s+|\n/)
    .map(space)
    .filter(Boolean)
}

/** «Метка: значение» with a short label; null for a part without one. */
function labelled(part: string): { label: string; value: string } | null {
  const m = /^([^:]{1,60}):\s*(.*)$/.exec(part)
  return m ? { label: space(m[1] ?? ''), value: m[2] ?? '' } : null
}

/** The form learned from texts: the parts and labels found word for word in `FORM_MIN_ORDERS` different orders. */
export function formPartsOf(texts: Iterable<string>, minOrders = FORM_MIN_ORDERS): FormParts {
  const parts = new Map<string, number>()
  const labels = new Map<string, number>()
  for (const text of texts) {
    const seen = new Set<string>()
    const seenLabels = new Set<string>()
    for (const p of splitParts(text)) {
      seen.add(key(p))
      const l = labelled(p)
      if (l) seenLabels.add(key(l.label))
    }
    for (const p of seen) parts.set(p, (parts.get(p) ?? 0) + 1)
    for (const l of seenLabels) labels.set(l, (labels.get(l) ?? 0) + 1)
  }
  const often = (m: Map<string, number>) =>
    new Set([...m].filter(([, n]) => n >= minOrders).map(([p]) => p))
  return { parts: often(parts), labels: often(labels) }
}

let learned: { at: number; form: FormParts } | null = null
/** The same splits as `splitParts` and `labelled`, for Postgres (bound, so no escaping goes wrong). */
const SPLIT = '\\s+·\\s+|\\n'
const SPACES = '\\s+'
const LABEL = '^([^:]{1,60}):'
const END = '[.;,]+$'

/**
 * The form as the orders of the last month show it, learned in the database and kept for an hour. A young database
 * knows little of the form, so more words count as the client's: the doubt goes the order's way.
 */
export async function loadFormParts(db: DbOrTx, now = Date.now()): Promise<FormParts> {
  if (learned && now - learned.at < FORM_TTL_MS) return learned.form
  const rows = await db.execute<{ kind: 'part' | 'label'; v: string }>(sql`
    with parts as (
      select distinct l.id,
        regexp_replace(regexp_replace(trim(p), ${SPACES}::text, ' ', 'g'), ${END}::text, '') as part
      from core.lead l, regexp_split_to_table(l.text, ${SPLIT}::text) as p
      where l.seen_at > now() - make_interval(days => ${FORM_DAYS}::int) and trim(p) <> ''
    )
    select 'part' as kind, part as v from parts group by part having count(*) >= ${FORM_MIN_ORDERS}
    union all
    select 'label', label from (
      select distinct id, trim(substring(part from ${LABEL}::text)) as label from parts
    ) s where label is not null group by label having count(*) >= ${FORM_MIN_ORDERS}`)
  const form: FormParts = { parts: new Set(), labels: new Set() }
  for (const r of rows.rows) (r.kind === 'part' ? form.parts : form.labels).add(key(r.v))
  learned = { at: now, form }
  return form
}

/** Tests start from an empty memory. */
export function forgetFormParts(): void {
  learned = null
}

const wordsOf = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter((w) => /\p{L}/u.test(w))

/**
 * The client's own words: every part of the text but the form's, and of a form label only its answer. The title
 * counts when it is not the form's (a category name) and not already in the text.
 */
export function ownWords(o: { title: string; text: string }, form: FormParts): string[] {
  const parts = splitParts(o.text)
  const title = space(o.title)
  if (title && !form.parts.has(key(title)) && !key(o.text).includes(key(title)))
    parts.unshift(title)
  const out: string[] = []
  for (const p of parts) {
    if (form.parts.has(key(p))) continue
    const l = labelled(p)
    out.push(...wordsOf(l && form.labels.has(key(l.label)) ? l.value : p))
  }
  return out
}

const MONTHS = [
  'январ',
  'феврал',
  'март',
  'апрел',
  'ма',
  'июн',
  'июл',
  'август',
  'сентябр',
  'октябр',
  'ноябр',
  'декабр',
]

/** A Moscow calendar day as «YYYY-MM-DD». */
export function mskDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

const dayString = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/**
 * The day the client came to Profi.ru, from «На Профи.ру с 7 сентября 2020» (a date without a year is of the order's
 * year, or the year before when it would be later than the order); «сегодня» and «вчера» are of the order's day.
 * Null: a form the code does not know, which is no data.
 */
export function sinceDay(since: string, orderDay: string): string | null {
  const s = since.toLowerCase().replace(/ё/g, 'е')
  if (/сегодня/.test(s)) return orderDay
  if (/вчера/.test(s)) {
    const d = new Date(`${orderDay}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 1)
    return d.toISOString().slice(0, 10)
  }
  const m = /с\s+(\d{1,2})\s+([а-я]+)(?:\s+(\d{4}))?/.exec(s)
  if (!m) return null
  const month = MONTHS.findIndex((p) =>
    p === 'ма' ? /^ма[яй]$/.test(m[2] ?? '') : (m[2] ?? '').startsWith(p),
  )
  if (month < 0) return null
  const day = Number(m[1])
  const orderYear = Number(orderDay.slice(0, 4))
  if (m[3]) return dayString(Number(m[3]), month + 1, day)
  const guess = dayString(orderYear, month + 1, day)
  return guess > orderDay ? dayString(orderYear - 1, month + 1, day) : guess
}

/** One criterion checked: it fired, it lacked its data, or it passed. */
export type Check = { hit: ScreenMark } | { noData: ScreenCriterion } | { pass: ScreenCriterion }

/** The criteria a set of checks looked at. */
export const checkedOf = (checks: Check[]): ScreenCriterion[] =>
  checks.map((c) => ('hit' in c ? c.hit.criterion : 'noData' in c ? c.noData : c.pass))

/** Criterion 1: the client's account was made on the day of the order. */
export function newAccount(info: ClientInfo | null, orderAt: Date): Check {
  if (!info?.on_profi_since) return { noData: 'new_account' }
  const orderDay = mskDay(orderAt)
  const since = sinceDay(info.on_profi_since, orderDay)
  if (since === null) return { noData: 'new_account' }
  if (since !== orderDay) return { pass: 'new_account' }
  const [y, m, d] = orderDay.split('-')
  return {
    hit: { criterion: 'new_account', basis: `«${info.on_profi_since}», заявка от ${d}.${m}.${y}` },
  }
}

/** Criterion 2: three or more negative reviews (1-3 of 5, as Profi.ru counts them). */
export function negativeReviews(info: ClientInfo | null): Check {
  const r = info?.reviews
  if (!r) return { noData: 'negative_reviews' }
  if (r.negative < 3) return { pass: 'negative_reviews' }
  return {
    hit: {
      criterion: 'negative_reviews',
      basis: `негативных отзывов ${r.negative}, положительных ${r.positive}`,
    },
  }
}

const QUOTE_MAX = 160
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

/** Criterion 3: fewer own words than `min`; an order without text is no data. */
export function shortText(o: { title: string; text: string }, form: FormParts, min: number): Check {
  if (!o.text.trim()) return { noData: 'short_text' }
  const words = ownWords(o, form)
  if (words.length >= min) return { pass: 'short_text' }
  return {
    hit: {
      criterion: 'short_text',
      basis:
        words.length === 0
          ? 'своих слов нет, только ответы формы'
          : `своими словами ${words.length} ${plural(words.length, ['слово', 'слова', 'слов'])}: «${clip(words.join(' '), QUOTE_MAX)}»`,
    },
  }
}

const loose = (s: string) =>
  key(s)
    .replace(/[«»"“”„'`]/g, '')
    .replace(/\s+/g, ' ')

/**
 * Criteria 4-6 from the Sorter's answer. A core with a quote found in the order fires; a core whose quote is not in the
 * order, or an unclear one, goes on with «уточнить в отклике» (a basis is needed, a doubt goes the order's way).
 */
export function senseMarks(
  o: { title: string; text: string },
  screen: SorterOutput['screen'] | undefined,
): { hits: ScreenMark[]; clarify: ScreenMark[] } {
  const hits: ScreenMark[] = []
  const clarify: ScreenMark[] = []
  const whole = loose(`${o.title}\n${o.text}`)
  for (const s of screen ?? []) {
    const quote = space(s.quote)
    const found = quote.length > 0 && whole.includes(loose(quote))
    const mark = { criterion: s.criterion, basis: quote ? `«${clip(quote, QUOTE_MAX)}»` : '' }
    if (hits.some((h) => h.criterion === s.criterion)) continue
    if (s.verdict === 'core' && found) hits.push(mark)
    else if (!clarify.some((c) => c.criterion === s.criterion)) clarify.push(mark)
  }
  return { hits, clarify: clarify.filter((c) => !hits.some((h) => h.criterion === c.criterion)) }
}

const order = (c: ScreenCriterion) => SCREEN_CRITERIA.indexOf(c)
const byOrder = <T extends { criterion: ScreenCriterion }>(xs: T[]) =>
  [...xs].sort((a, b) => order(a.criterion) - order(b.criterion))

/** One screen from its checks, the criteria in Boris's order. */
export function screenOf(
  checks: Check[],
  extra: { hits?: ScreenMark[]; clarify?: ScreenMark[] },
  p: { stops: boolean; ownWords: number | null; at: Date },
): LeadScreen {
  const hits = [...checks.flatMap((c) => ('hit' in c ? [c.hit] : [])), ...(extra.hits ?? [])]
  const noData = checks.flatMap((c) => ('noData' in c ? [c.noData] : []))
  return {
    stops: p.stops,
    hits: byOrder(hits),
    clarify: byOrder(extra.clarify ?? []),
    no_data: [...new Set(noData)].sort((a, b) => order(a) - order(b)),
    own_words: p.ownWords,
    at: p.at.toISOString(),
  }
}

/**
 * A later check adds to what an earlier one found on the same order; a criterion it looked at again (`checked`, passed
 * ones too) takes the new result.
 */
export function mergeScreens(
  before: LeadScreen | null,
  after: LeadScreen,
  checked: readonly ScreenCriterion[] = [],
): LeadScreen {
  if (!before) return after
  const again = new Set<ScreenCriterion>([
    ...checked,
    ...after.hits.map((h) => h.criterion),
    ...after.no_data,
    ...after.clarify.map((c) => c.criterion),
  ])
  const keep = <T extends { criterion: ScreenCriterion }>(xs: T[]) =>
    xs.filter((x) => !again.has(x.criterion))
  return {
    stops: after.stops,
    hits: byOrder([...keep(before.hits), ...after.hits]),
    clarify: byOrder([...keep(before.clarify), ...after.clarify]),
    no_data: [...new Set([...before.no_data.filter((c) => !again.has(c)), ...after.no_data])].sort(
      (a, b) => order(a) - order(b),
    ),
    own_words: after.own_words ?? before.own_words,
    at: after.at,
  }
}

/** «⛔ ОТСЕЯН — критерий — опора», one line per criterion (Boris's form, with a short dash for the long one). */
export function screenLines(s: Pick<LeadScreen, 'hits'>): string[] {
  return s.hits.map((h) => `⛔ ОТСЕЯН - ${SCREEN_RU[h.criterion]} - ${h.basis}`)
}

/** «уточнить в отклике» lines for the card. */
export function clarifyLines(s: Pick<LeadScreen, 'clarify'>): string[] {
  return s.clarify.map(
    (c) => `Уточнить в отклике: ${SCREEN_RU[c.criterion]}${c.basis ? `, ${c.basis}` : ''}`,
  )
}

/** The journal's payload: the criteria without the client's words (they stay on the lead, ADR-016). */
export function screenEvent(s: LeadScreen): Record<string, unknown> {
  return {
    stops: s.stops,
    out: s.hits.length > 0,
    criteria: s.hits.map((h) => h.criterion),
    clarify: s.clarify.map((c) => c.criterion),
    no_data: s.no_data,
    own_words: s.own_words,
  }
}

/** The summary's line: how many orders the screen stopped (or would have, in the shadow) and by which criteria. */
export function screenSummary(rows: Pick<LeadScreen, 'hits' | 'stops'>[]): string | null {
  const out = rows.filter((r) => r.hits.length > 0)
  if (out.length === 0) return null
  const counts = new Map<ScreenCriterion, number>()
  for (const r of out)
    for (const h of r.hits) counts.set(h.criterion, (counts.get(h.criterion) ?? 0) + 1)
  const by = [...counts]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([c, n]) => `${SCREEN_RU[c]} ${n}`)
    .join(', ')
  const shadow = out.every((r) => !r.stops)
  return shadow
    ? `Отсеяла бы ${out.length} (отсев пока только отмечает): ${by}`
    : `Отсеяно ${out.length}: ${by}`
}
