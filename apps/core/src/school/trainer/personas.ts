import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  ExamScenario,
  newEventId,
  normalizeText,
  Persona,
  PersonaOutput,
  type Topic,
} from '@sara/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../../db/client'
import { jobRun, persona } from '../../db/schema'
import { hasTag, redact } from '../../gateway/redact'
import { namesToHide } from '../../leads/clientName'
import type { NightJob, SchoolDeps } from '../types'

const MSK_MS = 3 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
/** The builder reads at most this many conversations, this many characters of the client's words each (5.7). */
const MAX_CHATS = 40
const CHAT_CHARS = 600
/** Fewer conversations than this: the trainer plays the handmade exam scenarios. */
const MIN_HISTORY = 10
/** A rebuild comes after a week, or sooner when this many conversations with a client's words are new. */
const REBUILD_DAYS = 7
const NEW_CHATS = 20
/** Built personas older than this are switched off once new ones come. */
const OLD_DAYS = 60
/** This many words in a row from a client's message make a persona too close to that client. */
const COPY_WORDS = 6
/** M4's handmade exam scenarios, in the repository (the image holds the whole repository). */
const HANDMADE_DIR = resolve(import.meta.dirname, '../../../../../tests/exam/scenarios')
const SONNET_UNITS = 4

const mskDay = (t: number) => new Date(t + MSK_MS).toISOString().slice(0, 10)

type Chat = { ref: string; text: string; names: string[] }

/**
 * The conversations a client wrote in, newest first: the platform's (node) and old Sara's (v1) messages, the client's
 * words only. Only chats whose client the core knows (an order with its lead) are read: without the name there is no
 * way to hide it, so such a chat is left out (NFR-PRIV-2). Each text is hidden first and cut after, at a word.
 */
async function historyChats(db: Db): Promise<Chat[]> {
  const rows = await db.execute<{ chat_id: string; text: string; names: string[] }>(sql`
    select m.chat_id, string_agg(m.text, ${'\n'} order by m.sent_at) as text,
      array_remove(array_agg(distinct l.client_name), null) as names
    from core.chat_message m left join core.lead l on l.id = m.order_id
    where m.source in ('node', 'v1') and m.author = 'client'
    group by m.account_id, m.chat_id
    having bool_or(l.id is not null)
    order by max(m.sent_at) desc
    limit ${MAX_CHATS}`)
  return rows.rows.map((r) => {
    const names = namesToHide(...(r.names ?? []))
    return { ref: r.chat_id, text: cutAtWord(redact(r.text, names).text, CHAT_CHARS), names }
  })
}

/** At most `max` characters, ending at a word: a cut never leaves half a phone or half a name. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max + 1).replace(/\s+\S*$/, '')
}

/** How many conversations of known clients have a client's words, all of them or those he wrote in since `since`. */
async function chatCount(db: Db, since?: Date): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select 1 from core.chat_message m left join core.lead l on l.id = m.order_id
      where m.source in ('node', 'v1') and m.author = 'client'
      group by m.account_id, m.chat_id
      having bool_or(l.id is not null)
        and ${since ? sql`max(m.sent_at) > ${since.toISOString()}` : sql`true`}) c`)
  return rows.rows[0]?.n ?? 0
}

/** The words of a text, in a row, without case and punctuation; a lone dash is no word. */
const words = (text: string) =>
  normalizeText(text)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))

function grams(text: string): Set<string> {
  const w = words(text)
  const out = new Set<string>()
  for (let i = 0; i + COPY_WORDS <= w.length; i++) out.add(w.slice(i, i + COPY_WORDS).join(' '))
  return out
}

/** Every text of a persona the trainer shows or plays. */
const personaText = (p: Omit<Persona, 'id' | 'source_refs' | 'handmade'>) =>
  [
    p.archetype,
    p.niche,
    p.task,
    p.style,
    ...p.questions,
    p.order.title,
    p.order.text,
    p.order.budget_text ?? '',
  ].join('\n')

/**
 * Why a persona is too close to a real client (NFR-PRIV-2, M5 design 5.7), or null: six words in a row from any chat
 * the builder read, a number of seven digits and more, a link, an e-mail, a phone, a client's name, or a gateway tag
 * (a tag stands for a real person's data).
 */
function privacyProblem(text: string, read: string[], names: string[]): string | null {
  const own = grams(text)
  for (const s of read) for (const g of grams(s)) if (own.has(g)) return 'copy'
  if (/\d{7,}/.test(text)) return 'number'
  if (hasTag(text)) return 'tag'
  const hidden = redact(text, names).counts
  if (hidden.link + hidden.email + hidden.phone + hidden.name > 0) return 'contact'
  return null
}

/**
 * The handmade exam scenarios as personas, marked so on the trainer's card (M5 design 5.7). A scenario that does not
 * make a valid persona, or carries a contact (the exam's trap scenarios do), is left out.
 */
export function handmadePersonas(scenarios: ExamScenario[]): Persona[] {
  return scenarios.flatMap((s) => {
    const p = Persona.safeParse({
      id: `p-h-${s.id.slice(2)}`,
      archetype: (s.tags.archetype || s.title).slice(0, 120),
      niche: (s.order.category || s.order.title || s.title).slice(0, 120),
      task: s.title.slice(0, 200),
      mood: s.tags.tone,
      style: '',
      questions: s.messages
        .filter((m) => m.author === 'client')
        .map((m) => m.text.slice(0, 200))
        .slice(0, 6),
      topics: s.expect.topic ? [s.expect.topic] : [],
      order: {
        title: (s.order.title || s.title).slice(0, 200),
        text: s.order.text.slice(0, 1500),
        budget_text: s.order.budget_text?.slice(0, 100) ?? null,
      },
      difficulty: s.tags.hard ? 3 : 1,
      hard: s.tags.hard,
      source_refs: [`handmade:${s.id}`],
      handmade: true,
    })
    return p.success && !privacyProblem(personaText(p.data), [], []) ? [p.data] : []
  })
}

/** M4's handmade scenarios from the repository; a file that does not parse is left out. */
async function readHandmade(dir = HANDMADE_DIR): Promise<ExamScenario[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'))
  const out: ExamScenario[] = []
  for (const f of files) {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(join(dir, f), 'utf8'))
    } catch {
      continue
    }
    const parsed = ExamScenario.safeParse(raw)
    if (parsed.success && parsed.data.source.kind === 'handmade') out.push(parsed.data)
  }
  return out
}

const toRow = (p: Persona, runId: string | null, now: Date) => ({
  id: p.id,
  archetype: p.archetype,
  niche: p.niche,
  task: p.task,
  mood: p.mood,
  style: p.style,
  questions: p.questions,
  topics: p.topics,
  order: p.order,
  difficulty: p.difficulty,
  hard: p.hard,
  sourceRefs: p.source_refs,
  handmade: p.handmade,
  active: true,
  builtAt: now.toISOString(),
  runId,
})

/** The night's build is marked only when it gave personas: a failed or empty one is tried again the next night. */
const markBuilt = (db: DbOrTx, now: Date) =>
  db
    .insert(jobRun)
    .values({ name: 'personas_run', day: mskDay(now.getTime()) })
    .onConflictDoNothing()

/**
 * Builds the trainer's personas (FR-TRAIN-2, M5 design 5.7). With fewer than 10 conversations of known clients the
 * handmade exam scenarios are the personas. Otherwise one call of `persona-builder` reads up to 40 numbered
 * conversations, the client's words only, each hidden (names, phones, e-mails, links) before it is cut; every persona
 * names the chats it came from (two at least), and one too close to a real client is refused. New personas switch
 * off the handmade ones and those older than 60 days.
 */
export async function buildPersonas(
  d: Pick<SchoolDeps, 'db' | 'gateway'>,
  now: Date,
  o: { handmade?: () => Promise<ExamScenario[]> } = {},
): Promise<'done' | 'nothing'> {
  if ((await chatCount(d.db)) < MIN_HISTORY) {
    const made = handmadePersonas(await (o.handmade ?? readHandmade)())
    if (made.length === 0) return 'nothing'
    await d.db.transaction(async (tx) => {
      for (const p of made)
        await tx
          .insert(persona)
          .values(toRow(p, null, now))
          .onConflictDoUpdate({
            target: persona.id,
            set: { ...toRow(p, null, now), builtAt: undefined },
          })
      await markBuilt(tx, now)
    })
    return 'done'
  }
  const chats = await historyChats(d.db)
  const names = [...new Set(chats.flatMap((c) => c.names))]
  const input = chats.map((c, i) => `Разговор ${i + 1}:\n<<<\n${c.text}\n>>>`).join('\n\n')
  const r = await d.gateway.call('persona-builder', input, PersonaOutput, {
    priority: 'P3',
    limitWaitMs: 0,
    // The tags stay in the answer: a persona is kept and must never hold a client's value.
    redact: { names, restore: false },
  })
  if (!r.ok) throw Object.assign(new Error('persona builder failed'), { name: r.errorClass })
  const runId = newEventId()
  const read = chats.map((c) => c.text)
  const kept: Persona[] = []
  for (const p of r.output.personas) {
    const sources = [...new Set(p.from)].map((n) => chats[n - 1]).filter((c) => !!c)
    if (sources.length < 2) continue
    const { from: _from, ...fields } = p
    if (privacyProblem(personaText(fields), read, names)) continue
    kept.push(
      Persona.parse({
        ...fields,
        id: `p-${runId}-${kept.length + 1}`,
        source_refs: sources.map((c) => c.ref),
        handmade: false,
      }),
    )
  }
  if (kept.length === 0) return 'nothing'
  await d.db.transaction(async (tx) => {
    await tx
      .update(persona)
      .set({ active: false })
      .where(
        and(
          eq(persona.active, true),
          sql`(${persona.handmade} or ${persona.builtAt} < ${new Date(now.getTime() - OLD_DAYS * DAY_MS).toISOString()})`,
        ),
      )
    await tx.insert(persona).values(kept.map((p) => toRow(p, runId, now)))
    await markBuilt(tx, now)
  })
  return 'done'
}

/** Whether the personas are due: never built, a week since the last build, or 20 new conversations since. */
async function due(db: Db, now: Date): Promise<boolean> {
  const [last] = (
    await db.execute<{ day: string | null }>(
      sql`select max(day)::text as day from core.job_run where name = 'personas_run'`,
    )
  ).rows
  if (!last?.day) return true
  const since = new Date(`${last.day}T00:00:00+03:00`)
  if (now.getTime() - since.getTime() >= REBUILD_DAYS * DAY_MS) return true
  return (await chatCount(db, since)) >= NEW_CHATS
}

/** The night job (02:45, sonnet): personas once a week or after 20 new conversations. */
export const personasJob: NightJob = {
  name: 'personas',
  atMsk: { hour: 2, minute: 45 },
  models: ['sonnet'],
  estimate: async (d, now) => ((await due(d.db, now)) ? SONNET_UNITS : 0),
  async run(d, now) {
    if (!(await due(d.db, now))) return 'nothing'
    return buildPersonas(d, now)
  },
}

/**
 * A persona for a training (FR-TRAIN-3): active ones only; the topics Boris trains first, then the hardness asked
 * for, then the one used least in the week before `now`; null when there are none.
 */
export async function pickPersona(
  db: Db,
  o: { preferTopics: Topic[]; hard: boolean; now?: Date },
): Promise<Persona | null> {
  const rows = await db.select().from(persona).where(eq(persona.active, true))
  if (rows.length === 0) return null
  const now = o.now ?? new Date()
  const uses = new Map(
    (
      await db.execute<{ persona_id: string; n: number }>(sql`
        select persona_id, count(*)::int as n from core.training_session
        where persona_id is not null
          and started_at > ${new Date(now.getTime() - 7 * DAY_MS).toISOString()}
          and started_at <= ${now.toISOString()}
        group by persona_id`)
    ).rows.map((r) => [r.persona_id, r.n]),
  )
  const topics = (p: (typeof rows)[number]) =>
    (p.topics as Topic[]).filter((t) => o.preferTopics.includes(t)).length
  const best = [...rows].sort(
    (a, b) =>
      topics(b) - topics(a) ||
      Number(b.hard === o.hard) - Number(a.hard === o.hard) ||
      (uses.get(a.id) ?? 0) - (uses.get(b.id) ?? 0) ||
      a.id.localeCompare(b.id),
  )[0]
  if (!best) return null
  return Persona.parse({
    id: best.id,
    archetype: best.archetype,
    niche: best.niche,
    task: best.task,
    mood: best.mood,
    style: best.style,
    questions: best.questions,
    topics: best.topics,
    order: best.order,
    difficulty: best.difficulty,
    hard: best.hard,
    source_refs: best.sourceRefs,
    handmade: best.handmade,
  })
}
