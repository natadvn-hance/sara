import type { ClientInfo } from '@sara/shared'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The words of a label or a tag: plain text, or an object with the words under the usual keys. */
function words(v: unknown): string | null {
  const s =
    typeof v === 'string'
      ? v
      : isObj(v)
        ? [v.text, v.title, v.name, v.label].find((x) => typeof x === 'string')
        : null
  const t = typeof s === 'string' ? s.trim() : ''
  return t === '' ? null : t
}

const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

const TAGS_MAX = 10

/**
 * What the order page says about the client: the backoffice answer getKlientInfo, whose data holds the name, the
 * date on Profi.ru (title, «На Профи.ру с 7 сентября 2020»), labels (one is «Номер подтверждён») and the reviews of
 * other specialists with their short tags. The form of labels and tags is not seen live yet, so words and objects
 * with a text both read. Only these five things leave the answer; its contacts never do. Null: not this answer.
 */
export function clientInfoFromAnswer(body: unknown): ClientInfo | null {
  const data = isObj(body) && isObj(body.data) ? body.data : null
  if (!data || typeof data.balance === 'number') return null
  const reviews = isObj(data.reviews) ? data.reviews : null
  const since =
    typeof data.title === 'string' && /Профи\.ру/i.test(data.title) ? data.title.trim() : null
  // The profile and the interface answers share the address; these three marks are the client answer's own.
  if (!(reviews && isObj(reviews.count)) && !Array.isArray(data.labels) && since === null)
    return null

  const labels = Array.isArray(data.labels) ? data.labels.map(words) : null
  const total = reviews && isObj(reviews.count) ? reviews.count : null
  const positive = count(total?.positive)
  const negative = count(total?.negative)
  const list = reviews && Array.isArray(reviews.list) ? reviews.list : []
  const tags = list
    .flatMap((r) => (isObj(r) && Array.isArray(r.tags) ? r.tags.map(words) : []))
    .filter((t): t is string => t !== null)
  const name = words(data.name)

  return {
    name,
    on_profi_since: since,
    phone_verified:
      labels === null ? null : labels.some((l) => l !== null && /номер\s+подтвержд[её]н/i.test(l)),
    reviews: positive !== null && negative !== null ? { positive, negative } : null,
    review_tags: tags.slice(0, TAGS_MAX),
  }
}
