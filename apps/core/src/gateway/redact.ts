/** The tag kinds the model sees in place of a client's data (ADR-016). */
const KINDS = { phone: 'телефон', email: 'почта', link: 'ссылка', name: 'имя' } as const
type Kind = keyof typeof KINDS

export type Redacted = {
  text: string
  /** Tag → the value it hides, as written in the input. */
  tags: Map<string, string>
  /** How many different values of each kind were hidden. */
  counts: Record<Kind, number>
}

const URL_CHARS = `[^\\s<>"'«»]`
const TLDS = 'ru|рф|su|com|net|org|info|biz|pro|io|me|online|site|shop|store|app|dev|by|kz|ua'

/** In this order: a link may hold an e-mail or a handle, an e-mail holds a domain. */
const PATTERNS: [Kind, RegExp][] = [
  ['link', new RegExp(`\\b(?:https?://|www\\.)${URL_CHARS}+`, 'giu')],
  // Every pattern starts at a word's start only: tried inside a long word, it would make the pass quadratic.
  ['email', /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu],
  [
    'link',
    new RegExp(
      `(?<![\\p{L}\\p{N}@._/-])(?:[\\p{L}\\p{N}-]+\\.)+(?:${TLDS})(?![\\p{L}\\p{N}-])(?:/${URL_CHARS}*)?`,
      // Case matters: a domain is written in lower case, "ASP.NET" is a technology.
      'gu',
    ),
  ],
  ['link', /(?<![\p{L}\p{N}._%+-])[@＠][A-Za-z_][A-Za-z0-9_.]*[A-Za-z0-9_]/gu],
  [
    'phone',
    new RegExp(
      [
        // Any number written with its country code: +375 29 123-45-67.
        String.raw`\+\d[\d\s()-]{7,}\d`,
        // A Russian number: 8 916 123 45 67, 89161234567, 7 (916) 123-45-67.
        String.raw`(?<![\d+])[78][\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)`,
        // A mobile number without the code: 916-123-45-67.
        String.raw`(?<![\d+])\(?9\d{2}\)?[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)`,
        // A city number: 123-45-67.
        String.raw`(?<![\d-])\d{3}-\d{2}-\d{2}(?![\d-])`,
      ].join('|'),
      'gu',
    ),
  ],
]

/** Punctuation that ends a sentence, not a link: "site.ru/a." keeps its dot outside the tag. */
function splitTail(value: string): [string, string] {
  const tail = /[.,;:!?)]+$/.exec(value)?.[0] ?? ''
  // A link with a "(" keeps its ")" (wiki pages).
  const keep = tail.startsWith(')') && value.includes('(') ? 1 : 0
  const cut = tail.length - keep
  return cut > 0 ? [value.slice(0, -cut), value.slice(-cut)] : [value, '']
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A given name as a whole word; names of 4 letters and more also with a Russian case ending (Ивану, Марии). */
function namePatterns(names: (string | null | undefined)[]): RegExp[] {
  const words = new Set<string>()
  for (const n of names) {
    const full = n?.trim().replace(/\s+/g, ' ')
    if (!full) continue
    words.add(full)
    for (const w of full.split(' ')) words.add(w)
  }
  return [...words]
    .filter((w) => [...w].filter((c) => /\p{L}/u.test(c)).length >= 2)
    .sort((a, b) => b.length - a.length)
    .map(
      (w) =>
        new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRe(w)}${w.length >= 4 ? '[а-яё]{0,3}' : ''}(?![\\p{L}\\p{N}])`,
          'giu',
        ),
    )
}

const TAG = /\[\s*(телефон|почта|ссылка|имя)\s*(\d+)\s*\]/giu

/**
 * Hides phones, e-mails, links, @-handles and the given names behind tags like `[телефон 1]` (ADR-016). One
 * value gets one tag; numbers already used by tags in the text are skipped, so restore never mistakes them.
 */
export function redact(text: string, names: (string | null | undefined)[] = []): Redacted {
  const used = new Set([...text.matchAll(TAG)].map((m) => `${m[1]?.toLowerCase()} ${m[2]}`))
  const tags = new Map<string, string>()
  const byValue = new Map<string, string>()
  const counts: Record<Kind, number> = { phone: 0, email: 0, link: 0, name: 0 }
  const next: Record<Kind, number> = { phone: 0, email: 0, link: 0, name: 0 }
  const tagFor = (kind: Kind, value: string) => {
    const known = byValue.get(`${kind}:${value}`)
    if (known) return known
    let tag: string
    do tag = `${KINDS[kind]} ${++next[kind]}`
    while (used.has(tag))
    const full = `[${tag}]`
    byValue.set(`${kind}:${value}`, full)
    tags.set(full, value)
    counts[kind]++
    return full
  }
  let out = text
  for (const [kind, re] of PATTERNS) {
    out = out.replace(re, (m) => {
      const [value, tail] = kind === 'link' ? splitTail(m) : [m, '']
      return `${tagFor(kind, value)}${tail}`
    })
  }
  for (const re of namePatterns(names)) out = out.replace(re, (m) => tagFor('name', m))
  return { text: out, tags, counts }
}

/** Puts the hidden values back into every string of a model's answer; a tag it does not know stays as written. */
export function restore<T>(value: T, tags: Map<string, string>): T {
  if (typeof value === 'string')
    return value.replace(
      TAG,
      (m, kind: string, n: string) => tags.get(`[${kind.toLowerCase()} ${n}]`) ?? m,
    ) as T
  if (Array.isArray(value)) return value.map((v) => restore(v, tags)) as T
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v, tags)])) as T
  return value
}
