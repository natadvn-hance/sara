/** The tag kinds the model sees in place of a client's data (ADR-016). */
const KINDS = { phone: 'телефон', email: 'почта', link: 'ссылка', name: 'имя' } as const
type Kind = keyof typeof KINDS

export type Redacted = {
  text: string
  /** Tag → the value it hides, as written in the input. */
  tags: Map<string, string>
  /** How many different values of each kind were hidden. */
  counts: Record<Kind, number>
  /** True when names were given to look for: without one, a name inside the text went through. */
  named: boolean
}

// No backslash: inside a JSON string it starts an escape ("\n", "\""), not a part of the link.
const URL_CHARS = `[^\\s<>"'«»\\\\]`
const TLDS =
  'ru|рф|su|com|net|org|info|biz|pro|io|me|online|site|shop|store|app|dev|by|kz|ua|cc|ee|be|ly|co|gl|to|tv|ws|link|page'
/** One optional separator between digit groups; never a line break. */
const S = '[ \\u00a0.-]?'
const AREA_AND_NUMBER = [
  `\\(?\\d{3}\\)?${S}\\d{3}${S}(?:\\d{2}${S}\\d{2}|\\d{4})`,
  `\\(?\\d{4}\\)?${S}(?:\\d{2}${S}\\d{2}${S}\\d{2}|\\d{3}${S}\\d{3})`,
  `\\(?\\d{5}\\)?${S}(?:\\d${S}\\d{2}${S}\\d{2}|\\d{3}${S}\\d{2})`,
].join('|')

/** In this order: a link may hold an e-mail or a handle, an e-mail holds a domain. */
const PATTERNS: [Kind, RegExp][] = [
  ['link', new RegExp(`\\b(?:https?://|www\\.)${URL_CHARS}+`, 'giu')],
  // Every pattern starts at a word's start only: tried inside a long word, it would make the pass quadratic.
  ['email', /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu],
  // A domain with a path, in any case: VK.COM/ivan, taplink.cc/ivan.
  [
    'link',
    new RegExp(`(?<![\\p{L}\\p{N}@._/-])(?:[a-z0-9-]+\\.)+(?:${TLDS})/${URL_CHARS}*`, 'giu'),
  ],
  // A bare domain only in lower case: "site.ru" is a link, "ASP.NET" is a technology.
  [
    'link',
    new RegExp(
      `(?<![\\p{L}\\p{N}@._/-])(?:[\\p{L}\\p{N}-]+\\.)+(?:${TLDS})(?![\\p{L}\\p{N}-])`,
      'gu',
    ),
  ],
  ['link', /(?<![\p{L}\p{N}._%+-])[@＠][A-Za-z_][A-Za-z0-9_.]*[A-Za-z0-9_]/gu],
  [
    'phone',
    new RegExp(
      [
        // A Russian number with its code: +7 (916) 123-45-67, 89161234567, 8 (8452) 12-34-56.
        `(?<![\\d+])(?:\\+7|8|7)${S}(?:${AREA_AND_NUMBER})(?!\\d)`,
        // Without the code, the area in brackets: (812)1234567, (34342) 2-12-34.
        `(?<![\\d+(])\\((?:\\d{3}\\)${S}\\d{3}${S}(?:\\d{2}${S}\\d{2}|\\d{4})|\\d{4}\\)${S}(?:\\d{2}${S}\\d{2}${S}\\d{2}|\\d{3}${S}\\d{3})|\\d{5}\\)${S}(?:\\d${S}\\d{2}${S}\\d{2}|\\d{3}${S}\\d{2}))(?!\\d)`,
        // Another country: +375 29 123-45-67, +1 (555) 123-4567.
        `\\+(?!7)\\d{1,3}${S}\\(?\\d{2,4}\\)?${S}\\d{2,4}${S}\\d{2,4}(?:${S}\\d{2,4})?(?!\\d)`,
        // Ten digits without the code: 916-123-45-67, 495 1234567, 916.123.45.67.
        `(?<![\\d+])\\d{3}${S}\\d{3}${S}(?:\\d{2}${S}\\d{2}|\\d{4})(?!\\d)`,
        // A city number: 123-45-67, 12-34-56.
        `(?<![\\d-])\\d{2,3}-\\d{2}-\\d{2}(?![\\d-])`,
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

/** Russian case endings of a name: Ивану, Марии, Ольгой, Петровым. */
const ENDINGS = 'ой|ей|ом|ем|ём|ою|ею|ью|ым|им|а|я|у|ю|е|ё|ы|и|й|ь'

/** One name word as a pattern: е and ё alike; a stem with its case endings for names of 4 letters and more. */
function nameWord(w: string): string {
  const chars = (s: string) =>
    [...s]
      .map((c) => (/[её]/i.test(c) ? '[её]' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('')
  if ([...w].length < 4) return chars(w)
  // Мария → Мари + я|и|ю|ей; without its last vowel the stem alone is another word (Ника, Ник).
  if (/[аяйьеоё]$/i.test(w)) return `${chars(w.slice(0, -1))}(?:${ENDINGS})`
  return `${chars(w)}(?:${ENDINGS})?`
}

/** All given names in one pattern, so tags go by their place in the text; a full name before its parts. */
function namePattern(names: (string | null | undefined)[]): RegExp | null {
  const variants = new Set<string>()
  for (const n of names) {
    const full = n?.trim().replace(/\s+/g, ' ')
    if (!full) continue
    variants.add(full)
    for (const w of full.split(' ')) variants.add(w)
  }
  const kept = [...variants]
    .filter((v) => [...v].filter((c) => /\p{L}/u.test(c)).length >= 2)
    .sort((a, b) => b.length - a.length)
  if (kept.length === 0) return null
  const alts = kept.map((v) => v.split(' ').map(nameWord).join(' '))
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'giu')
}

const TAG = /\[\s*(телефон|почта|ссылка|имя)\s*(\d+)\s*\]/giu

/** One hiding that spans several texts: a value keeps its tag in all of them, so one restore fits every answer. */
export type Redactor = {
  /** The text with this redactor's tags; a value seen in an earlier text keeps the tag it got there. */
  hide(text: string): string
  /** Tag → the value it hides, as written in the input. */
  readonly tags: Map<string, string>
  /** How many different values of each kind were hidden so far. */
  readonly counts: Record<Kind, number>
  /** True when names were given to look for: without one, a name inside the text went through. */
  readonly named: boolean
}

/**
 * Hides phones, e-mails, links, @-handles and the given names behind tags like `[телефон 1]` (ADR-016). One
 * value gets one tag; numbers already used by tags in a text are skipped, so restore never mistakes them.
 */
export function createRedactor(names: (string | null | undefined)[] = []): Redactor {
  const used = new Set<string>()
  const tags = new Map<string, string>()
  const byValue = new Map<string, string>()
  const counts: Record<Kind, number> = { phone: 0, email: 0, link: 0, name: 0 }
  const next: Record<Kind, number> = { phone: 0, email: 0, link: 0, name: 0 }
  const nameRe = namePattern(names)
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
  return {
    hide(text) {
      for (const m of text.matchAll(TAG)) used.add(`${m[1]?.toLowerCase()} ${m[2]}`)
      let out = text
      for (const [kind, re] of PATTERNS) {
        out = out.replace(re, (m) => {
          const [value, tail] = kind === 'link' ? splitTail(m) : [m, '']
          return `${tagFor(kind, value)}${tail}`
        })
      }
      if (nameRe) out = out.replace(nameRe, (m) => tagFor('name', m))
      return out
    },
    tags,
    counts,
    named: nameRe !== null,
  }
}

/** One text hidden on its own (ADR-016): see `createRedactor`. */
export function redact(text: string, names: (string | null | undefined)[] = []): Redacted {
  const r = createRedactor(names)
  const out = r.hide(text)
  return { text: out, tags: r.tags, counts: r.counts, named: r.named }
}

/** A tag like `[имя 3]` is in the text: one that `restore` did not know stays as the model wrote it. */
export const hasTag = (text: string) => /\[\s*(?:телефон|почта|ссылка|имя)\s*\d+\s*\]/iu.test(text)

/** The tags a text holds, sorted: two texts with the same list hide the same values. */
export const tagsIn = (text: string): string[] =>
  [...text.matchAll(TAG)].map((m) => `${m[1]?.toLowerCase()} ${m[2]}`).sort()

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
