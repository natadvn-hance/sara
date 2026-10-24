// pnpm profi:samples --since <date> [--kind rtp|response|dom]: turns calibration records of node.raw_event into
// anonymized test samples in tests/fixtures/profi/<kind>/ (plan M1, Task 15). Runs where DATABASE_URL reaches the
// records; `--file <records.json>` takes records exported from the server instead ({ name, kind, url, body,
// receivedAt }[]). Refuses to write a sample in which a phone, an e-mail, a name or a client's text is still found
// (ADR-022).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type SampleRecord = {
  kind: 'rtp' | 'response' | 'dom'
  url: string | null
  body: unknown
  receivedAt: string
}

const PHONE = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const PROFILE = /(profi\.ru\/profile\/)([^/?#\s"']+)/g
// Numbers of orders, chats, messages, users: «id», «_id», «order_id», «orderId», «messengerExtId», «pid».
const ID_KEY = /^(id|pid)$|_id$|(order|chat|message)id$/i
const CAMEL_ID_KEY = /[a-z](Id|ID)$/
const isIdKey = (k: string) => ID_KEY.test(k) || CAMEL_ID_KEY.test(k)
// A Profi.ru profile id, like «PetrovaIA» or «IvanovPP7»: a surname and initials.
const PROFILE_ID = /^[A-Z][a-z]+[A-Z]{1,3}\d*$/
const PROFILE_PARAM = /[?&][\w-]+=([A-Z][a-z]+[A-Z]{1,3}\d*)(?=[&#\s"']|$)/g
// An order or chat number in a link of the site: «r.php?id=95147898», «n.php?o=95147898».
const LINK_ID = /[?&](?:id|o|order_?id|chat_?id)=(\d{5,})(?=[&#\s"']|$)/gi
// A link parameter that opens something without a login, like «bo_tkn» in the refund link of the profile.
const TOKEN_PARAM =
  /([?&][\w-]*(?:tkn|token|key|secret|sig|hash|auth|session)[\w-]*=)([^&#\s"']{8,})/gi
const NAME_KEY = /name|fio|first|last|surname|nick/i
const TEXT_KEY =
  /text|description|message|comment|body|subject|title|content|question|answer|quote/i
// «textColor», «buttonStyle»: how a text looks, not what it says.
const STYLE_KEY = /(color|style|type|icon|variant)$/i
const isTextKey = (k: string) => TEXT_KEY.test(k) && !STYLE_KEY.test(k)
const ADDRESS_KEY = /^(addr|address|street)$/i
const COORD_KEY = /^(lat|lon|lng|latitude|longitude)$/i
const CYRILLIC_WORD = /[А-Яа-яЁё]+/g
// Names are written with a capital; «усл.» under a name key is a unit, not a person.
const CYRILLIC_NAME = /[А-ЯЁ][а-яё]{2,}/g
// «Denis», «PalKom»: a capital letter makes a name; «stavka» under a name key is a form field.
const LATIN_NAME_WORD = /[A-Z][A-Za-z]{2,}/g
const isPersonName = (s: string) => /[А-Яа-яЁёA-Z]/.test(s)
const LONG_NUMBER = /\d{5,}/g
// File names of uploaded photos and documents (cdn.profi.ru/xfiles/...): long runs of hex.
const FILE_HASH = /[0-9a-f]{16,}/gi
const LONG_DASH = new RegExp(String.fromCharCode(0x2014), 'g')
// An encrypted or signed value, like the price hash of the bid form: no sample needs what is inside.
const OPAQUE = /^(?!\/)[A-Za-z0-9+/=:_-]{64,}$/

type Ctx = {
  ids: Map<string, string>
  profiles: Map<string, string>
  tokens: Set<string>
  names: Set<string>
  counter: { text: number; name: number; mail: number; phone: number; addr: number }
}

function newCtx(): Ctx {
  return {
    ids: new Map(),
    profiles: new Map(),
    tokens: new Set(),
    names: new Set(),
    counter: { text: 0, name: 0, mail: 0, phone: 0, addr: 0 },
  }
}

function placeholder(base: string, length: number): string {
  if (length <= 0) return ''
  let out = ''
  while (out.length < length) out += `${base} `
  return out.slice(0, length)
}

/** JSON written inside a string, like the frames of the event stream: «a["{\"type\":...}"]». */
function nested(s: string): { prefix: string; value: unknown } | null {
  const prefix = s.startsWith('a[') ? 'a' : ''
  const json = s.slice(prefix.length)
  if (!json.startsWith('[') && !json.startsWith('{')) return null
  try {
    const value: unknown = JSON.parse(json)
    return value && typeof value === 'object' ? { prefix, value } : null
  } catch {
    return null
  }
}

function addProfile(id: string, ctx: Ctx): void {
  // It is replaced inside every string, so a stray short match must not take whole letters out.
  if (id.length >= 4 && !ctx.profiles.has(id)) ctx.profiles.set(id, `anon${ctx.profiles.size + 1}`)
}

function addId(id: string, ctx: Ctx): void {
  if (!ctx.ids.has(id)) ctx.ids.set(id, String(10 ** (id.length - 1) + ctx.ids.size + 1))
}

function collect(v: unknown, key: string, ctx: Ctx): void {
  if (Array.isArray(v)) {
    for (const x of v) collect(x, key, ctx)
    return
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) collect(x, k, ctx)
    return
  }
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : null
  if (s === null) return
  const inner = typeof v === 'string' ? nested(s) : null
  if (inner) {
    collect(inner.value, key, ctx)
    return
  }
  if (isIdKey(key) && /^\d{5,}$/.test(s)) addId(s, ctx)
  for (const m of s.matchAll(LINK_ID)) addId(m[1] ?? '', ctx)
  if (isIdKey(key) && PROFILE_ID.test(s)) addProfile(s, ctx)
  for (const m of s.matchAll(PROFILE)) addProfile(m[2] ?? '', ctx)
  for (const m of s.matchAll(PROFILE_PARAM)) addProfile(m[1] ?? '', ctx)
  for (const m of s.matchAll(TOKEN_PARAM)) ctx.tokens.add(m[2] ?? '')
  // A place under a name key («Москва, улица ..., 42») is replaced where it stands, its words are not names.
  if (NAME_KEY.test(key) && typeof v === 'string' && !/\d/.test(v)) {
    for (const w of v.match(CYRILLIC_NAME) ?? []) ctx.names.add(w)
    for (const w of v.match(LATIN_NAME_WORD) ?? []) ctx.names.add(w)
  }
}

function scrubString(s: string, key: string, ctx: Ctx): string {
  if (NAME_KEY.test(key) && isPersonName(s)) return `Клиент ${++ctx.counter.name}`
  if (ADDRESS_KEY.test(key)) return placeholder(`Адрес ${++ctx.counter.addr}`, s.length)
  if (isTextKey(key) && !s.includes('<'))
    return placeholder(`Текст ${++ctx.counter.text}`, s.length)
  if (OPAQUE.test(s)) return 'x'.repeat(s.length)
  let out = s
    .replace(LONG_DASH, '-')
    .replace(EMAIL, () => `user${++ctx.counter.mail}@example.com`)
    .replace(PHONE, () => `+7 900 000-00-${String(++ctx.counter.phone).padStart(2, '0')}`)
    .replace(TOKEN_PARAM, (_m, head: string, v: string) => head + 'x'.repeat(v.length))
    .replace(FILE_HASH, (h) => (/[a-f]/i.test(h) ? '0'.repeat(h.length) : h))
    .replace(LONG_NUMBER, (n) => ctx.ids.get(n) ?? n)
  for (const [id, anon] of ctx.profiles) out = out.split(id).join(anon)
  for (const name of ctx.names) out = out.split(name).join(placeholder('Имя', name.length))
  // HTML of a page: tags and classes stay, every Russian word becomes Latin x's of the same length.
  if (out.includes('<'))
    out = out
      .replace(CYRILLIC_WORD, (w) => 'x'.repeat(w.length))
      .replace(/\d{2,}/g, (d) => ctx.ids.get(d) ?? '0'.repeat(d.length))
  return out
}

function scrub(v: unknown, key: string, ctx: Ctx): unknown {
  if (Array.isArray(v)) return v.map((x) => scrub(x, key, ctx))
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k, ctx)]))
  }
  if (typeof v === 'number' && isIdKey(key)) return Number(ctx.ids.get(String(v)) ?? v)
  // About 100 km: the region stays, the house does not.
  if (typeof v === 'number' && COORD_KEY.test(key)) return Math.round(v)
  if (typeof v === 'string') {
    const inner = nested(v)
    if (inner) return inner.prefix + JSON.stringify(scrub(inner.value, key, ctx))
    if (isIdKey(key) && ctx.ids.has(v)) return ctx.ids.get(v)
    return scrubString(v, key, ctx)
  }
  return v
}

/** One record into a sample: personal data replaced, numbers of orders and chats renamed the same way throughout. */
export function anonymize(r: SampleRecord): SampleRecord {
  const ctx = newCtx()
  collect(r.body, '', ctx)
  if (r.url) collect(r.url, 'url', ctx)
  const body = scrub(r.body, '', ctx)
  const url = r.url === null ? null : scrubString(r.url, 'url', ctx)
  return { kind: r.kind, url, body, receivedAt: r.receivedAt }
}

/** What of the original's personal data is still in the output. Empty means the sample may be written. */
export function findLeaks(original: SampleRecord, output: SampleRecord): string[] {
  const text = JSON.stringify(output)
  const leaks = new Set<string>()
  for (const m of text.match(PHONE) ?? []) if (!m.startsWith('+7 900 000-00-')) leaks.add(m)
  for (const m of text.match(EMAIL) ?? []) if (!m.endsWith('@example.com')) leaks.add(m)
  const ctx = newCtx()
  collect(original.body, '', ctx)
  if (original.url) collect(original.url, 'url', ctx)
  for (const n of ctx.names) if (text.includes(n)) leaks.add(n)
  for (const p of ctx.profiles.keys()) if (text.includes(p)) leaks.add(p)
  for (const t of ctx.tokens) if (t && text.includes(t)) leaks.add(t)
  for (const id of ctx.ids.keys()) if (new RegExp(`(^|\\D)${id}(\\D|$)`).test(text)) leaks.add(id)
  const walk = (v: unknown, key: string) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key)
      return
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k)
      return
    }
    if (typeof v !== 'string') return
    const inner = nested(v)
    if (inner) {
      walk(inner.value, key)
      return
    }
    if (isTextKey(key) && v.length >= 8 && text.includes(v.slice(0, 12))) leaks.add(v.slice(0, 12))
  }
  walk(original.body, '')
  for (const m of JSON.stringify(original).match(PROFILE) ?? []) if (text.includes(m)) leaks.add(m)
  return [...leaks]
}

/** Anonymized records into <root>/<kind>/<name>.json; a record with anything left of the original is refused. */
export async function writeSamples(
  records: (SampleRecord & { name?: string })[],
  root: string,
): Promise<{ written: string[]; refused: { name: string; leaks: number }[] }> {
  const written: string[] = []
  const refused: { name: string; leaks: number }[] = []
  const count: Record<string, number> = {}
  for (const r of records) {
    count[r.kind] = (count[r.kind] ?? 0) + 1
    const name = r.name ?? String(count[r.kind])
    const original: SampleRecord = {
      kind: r.kind,
      url: r.url,
      body: r.body,
      receivedAt: r.receivedAt,
    }
    const sample = anonymize(original)
    const leaks = findLeaks(original, sample)
    if (leaks.length > 0) {
      refused.push({ name: `${r.kind}/${name}`, leaks: leaks.length })
      continue
    }
    await mkdir(join(root, r.kind), { recursive: true })
    await writeFile(join(root, r.kind, `${name}.json`), `${JSON.stringify(sample, null, 2)}\n`)
    written.push(`${r.kind}/${name}.json`)
  }
  return { written, refused }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const root = resolve(import.meta.dirname, '../tests/fixtures/profi')
  const file = arg('file')
  const since = arg('since')
  if (!file && !since) {
    console.log(
      'Укажи дату: pnpm profi:samples --since 2026-10-25 [--kind rtp|response|dom], или файл: --file records.json',
    )
    process.exit(1)
  }
  let records: (SampleRecord & { name?: string })[] = []
  if (file) {
    records = JSON.parse(await readFile(file, 'utf8'))
  } else {
    const kinds = arg('kind')
      ? [arg('kind') as SampleRecord['kind']]
      : (['rtp', 'response', 'dom'] as const)
    const pg = (await import('pg')).default
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    for (const kind of kinds) {
      const rows = await client.query<{ url: string | null; body: unknown; received_at: Date }>(
        'select url, body, received_at from node.raw_event where kind = $1 and received_at >= $2 order by received_at limit 5',
        [kind, since],
      )
      for (const row of rows.rows)
        records.push({
          kind,
          url: row.url,
          body: row.body,
          receivedAt: row.received_at.toISOString(),
        })
    }
    await client.end()
  }
  const res = await writeSamples(records, root)
  for (const r of res.refused)
    console.log(`Образец ${r.name} не записан: остались данные клиента (${r.leaks} шт.)`)
  console.log(
    `Записано образцов: ${res.written.length}. Перед коммитом просмотри каждый файл глазами.`,
  )
}
