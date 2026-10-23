// pnpm profi:samples --since <date> [--kind rtp|response|dom]: turns calibration records of node.raw_event into
// anonymized test samples in tests/fixtures/profi/<kind>/ (plan M1, Task 15). Runs on the server; refuses to
// write a sample in which a phone, an e-mail, a name or a client's text is still found (ADR-022).
import { mkdir, writeFile } from 'node:fs/promises'
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
const ID_KEY = /(^|_)(order_?id|chat_?id|orderid|chatid|message_?id|id)$/i
const NAME_KEY = /name|fio|first|last|surname|nick/i
const TEXT_KEY =
  /text|description|message|comment|body|subject|title|content|question|answer|quote/i
const CYRILLIC_WORD = /[А-Яа-яЁё]+/g
const LONG_NUMBER = /\d{5,}/g

type Ctx = {
  ids: Map<string, string>
  names: Set<string>
  counter: { text: number; name: number; mail: number; phone: number }
}

function placeholder(base: string, length: number): string {
  if (length <= 0) return ''
  let out = ''
  while (out.length < length) out += `${base} `
  return out.slice(0, length)
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
  if (ID_KEY.test(key) && /^\d{5,}$/.test(s) && !ctx.ids.has(s)) {
    ctx.ids.set(s, String(10 ** (s.length - 1) + ctx.ids.size + 1))
  }
  if (NAME_KEY.test(key) && typeof v === 'string') {
    for (const w of v.match(CYRILLIC_WORD) ?? []) if (w.length >= 3) ctx.names.add(w)
  }
}

function scrubString(s: string, key: string, ctx: Ctx): string {
  if (NAME_KEY.test(key) && /[А-Яа-яЁё]/.test(s)) return `Клиент ${++ctx.counter.name}`
  if (TEXT_KEY.test(key) && !s.includes('<'))
    return placeholder(`Текст ${++ctx.counter.text}`, s.length)
  let out = s
    .replace(EMAIL, () => `user${++ctx.counter.mail}@example.com`)
    .replace(PHONE, () => `+7 900 000-00-${String(++ctx.counter.phone).padStart(2, '0')}`)
    .replace(PROFILE, (_m, head: string) => `${head}anon${ctx.counter.name + 1}`)
    .replace(LONG_NUMBER, (n) => ctx.ids.get(n) ?? n)
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
  if (typeof v === 'number' && ID_KEY.test(key)) return Number(ctx.ids.get(String(v)) ?? v)
  if (typeof v === 'string') {
    if (ID_KEY.test(key) && ctx.ids.has(v)) return ctx.ids.get(v)
    return scrubString(v, key, ctx)
  }
  return v
}

/** One record into a sample: personal data replaced, numbers of orders and chats renamed the same way throughout. */
export function anonymize(r: SampleRecord): SampleRecord {
  const ctx: Ctx = {
    ids: new Map(),
    names: new Set(),
    counter: { text: 0, name: 0, mail: 0, phone: 0 },
  }
  collect(r.body, '', ctx)
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
  const ctx: Ctx = {
    ids: new Map(),
    names: new Set(),
    counter: { text: 0, name: 0, mail: 0, phone: 0 },
  }
  collect(original.body, '', ctx)
  for (const n of ctx.names) if (text.includes(n)) leaks.add(n)
  const walk = (v: unknown, key: string) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key)
      return
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k)
      return
    }
    if (
      typeof v === 'string' &&
      TEXT_KEY.test(key) &&
      v.length >= 8 &&
      text.includes(v.slice(0, 12))
    )
      leaks.add(v.slice(0, 12))
  }
  walk(original.body, '')
  for (const m of JSON.stringify(original).match(PROFILE) ?? []) if (text.includes(m)) leaks.add(m)
  return [...leaks]
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const since = arg('since')
  if (!since) {
    console.log('Укажи дату: pnpm profi:samples --since 2026-10-25 [--kind rtp|response|dom]')
    process.exit(1)
  }
  const kinds = arg('kind')
    ? [arg('kind') as SampleRecord['kind']]
    : (['rtp', 'response', 'dom'] as const)
  const pg = (await import('pg')).default
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const root = resolve(import.meta.dirname, '../tests/fixtures/profi')
  let written = 0
  for (const kind of kinds) {
    const rows = await client.query<{
      id: string
      url: string | null
      body: unknown
      received_at: Date
    }>(
      'select id, url, body, received_at from node.raw_event where kind = $1 and received_at >= $2 order by received_at limit 5',
      [kind, since],
    )
    await mkdir(join(root, kind), { recursive: true })
    for (const [i, row] of rows.rows.entries()) {
      const original: SampleRecord = {
        kind,
        url: row.url,
        body: row.body,
        receivedAt: row.received_at.toISOString(),
      }
      const sample = anonymize(original)
      const leaks = findLeaks(original, sample)
      if (leaks.length > 0) {
        console.log(
          `Образец ${kind} ${row.id} не записан: остались данные клиента (${leaks.length} шт.)`,
        )
        continue
      }
      await writeFile(join(root, kind, `${i + 1}.json`), `${JSON.stringify(sample, null, 2)}\n`)
      written++
    }
  }
  await client.end()
  console.log(`Записано образцов: ${written}. Перед коммитом просмотри каждый файл глазами.`)
}
