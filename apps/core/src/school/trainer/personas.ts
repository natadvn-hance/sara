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
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { jobRun, lead, persona } from '../../db/schema'
import { redact } from '../../gateway/redact'
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

type Chat = { ref: string; text: string; orderIds: string[] }

/** The conversations a client wrote in, newest first: the platform's (node) and old Sara's (v1) messages. */
async function historyChats(db: Db): Promise<Chat[]> {
  const rows = await db.execute<{ chat_id: string; text: string; orders: string[] }>(sql`
    select chat_id, string_agg(text, ${'\n'} order by sent_at) as text,
      array_remove(array_agg(distinct order_id), null) as orders
    from core.chat_message
    where source in ('node', 'v1') and author = 'client'
    group by account_id, chat_id
    order by max(sent_at) desc
    limit ${MAX_CHATS}`)
  return rows.rows.map((r) => ({
    ref: r.chat_id,
    text: r.text.slice(0, CHAT_CHARS),
    orderIds: r.orders ?? [],
  }))
}

/** How many conversations have a client's words, all of them or only those he wrote in since `since`. */
async function chatCount(db: Db, since?: Date): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select 1 from core.chat_message
      where source in ('node', 'v1') and author = 'client'
      group by account_id, chat_id
      having ${since ? sql`max(sent_at) > ${since.toISOString()}` : sql`true`}) c`)
  return rows.rows[0]?.n ?? 0
}

/** The words of a text, in a row, without case and punctuation. */
const words = (text: string) =>
  normalizeText(text)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

function grams(text: string): Set<string> {
  const w = words(text)
  const out = new Set<string>()
  for (let i = 0; i + COPY_WORDS <= w.length; i++) out.add(w.slice(i, i + COPY_WORDS).join(' '))
  return out
}

/** Every text of a persona the trainer shows or plays. */
const personaText = (p: PersonaOutput['personas'][number]) =>
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
 * Why a persona is too close to a real client (NFR-PRIV-2, M5 design 5.7), or null: six words in a row from its
 * sources, a long number, a link, an e-mail, a phone, or a gateway tag (a tag stands for a real person's data).
 */
function privacyProblem(text: string, sources: string[]): string | null {
  const own = grams(text)
  for (const s of sources) for (const g of grams(s)) if (own.has(g)) return 'copy'
  if (/\d(?:[\s.-]?\d){6,}/.test(text)) return 'number'
  const hidden = redact(text, []).counts
  if (hidden.link + hidden.email + hidden.phone > 0) return 'contact'
  if (/\[(?:имя|телефон|почта|ссылка) \d+\]/u.test(text)) return 'tag'
  return null
}

/** The handmade exam scenarios as personas, marked so on the trainer's card (M5 design 5.7). */
export function handmadePersonas(scenarios: ExamScenario[]): Persona[] {
  return scenarios.map((s) =>
    Persona.parse({
      id: `p-h-${s.id.slice(2)}`,
      archetype: (s.tags.archetype ?? s.title).slice(0, 120),
      niche: (s.order.category || s.order.title).slice(0, 120),
      task: s.title.slice(0, 200),
      mood: s.tags.tone,
      style: '',
      questions: s.messages
        .filter((m) => m.author === 'client')
        .map((m) => m.text.slice(0, 200))
        .slice(0, 6),
      topics: s.expect.topic ? [s.expect.topic] : [],
      order: {
        title: s.order.title.slice(0, 200),
        text: s.order.text.slice(0, 1500),
        budget_text: s.order.budget_text?.slice(0, 100) ?? null,
      },
      difficulty: s.tags.hard ? 3 : 1,
      hard: s.tags.hard,
      source_refs: [`handmade:${s.id}`],
      handmade: true,
    }),
  )
}

/** M4's handmade scenarios from the repository; a file that does not parse is left out. */
async function readHandmade(dir = HANDMADE_DIR): Promise<ExamScenario[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'))
  const out: ExamScenario[] = []
  for (const f of files) {
    const parsed = ExamScenario.safeParse(
      JSON.parse(await readFile(join(dir, f), 'utf8').catch(() => 'null')),
    )
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

/**
 * Builds the trainer's personas (FR-TRAIN-2, M5 design 5.7). With fewer than 10 conversations the handmade exam
 * scenarios are the personas. Otherwise one call of `persona-builder` reads up to 40 numbered conversations, the
 * client's words only, with names and contacts hidden by the gateway; every persona names the chats it came from
 * (two at least), and one too close to a real client is refused. New personas switch off the handmade ones and those
 * older than 60 days.
 */
export async function buildPersonas(
  d: Pick<SchoolDeps, 'db' | 'gateway'>,
  now: Date,
  o: { handmade?: () => Promise<ExamScenario[]> } = {},
): Promise<'done' | 'nothing'> {
  await d.db
    .insert(jobRun)
    .values({ name: 'personas_run', day: mskDay(now.getTime()) })
    .onConflictDoNothing()
  if ((await chatCount(d.db)) < MIN_HISTORY) {
    const made = handmadePersonas(await (o.handmade ?? readHandmade)())
    for (const p of made)
      await d.db
        .insert(persona)
        .values(toRow(p, null, now))
        .onConflictDoUpdate({
          target: persona.id,
          set: { ...toRow(p, null, now), builtAt: undefined },
        })
    return made.length > 0 ? 'done' : 'nothing'
  }
  const chats = await historyChats(d.db)
  const names = await clientNames(d.db, chats)
  const input = chats.map((c, i) => `Разговор ${i + 1}:\n<<<\n${c.text}\n>>>`).join('\n\n')
  const r = await d.gateway.call('persona-builder', input, PersonaOutput, {
    priority: 'P3',
    limitWaitMs: 0,
    // The tags stay in the answer: a persona is kept and must never hold a client's value.
    redact: { names, restore: false },
  })
  if (!r.ok) throw Object.assign(new Error('persona builder failed'), { name: r.errorClass })
  const runId = newEventId()
  const kept: Persona[] = []
  for (const p of r.output.personas) {
    const sources = [...new Set(p.from)].map((n) => chats[n - 1]).filter((c) => !!c)
    if (sources.length < 2) continue
    const text = personaText(p)
    if (
      privacyProblem(
        text,
        sources.map((c) => c.text),
      )
    )
      continue
    const { from: _from, ...fields } = p
    kept.push(
      Persona.parse({
        ...fields,
        id: `p-${runId.slice(0, 8)}-${kept.length + 1}`,
        source_refs: sources.map((c) => c.ref),
        handmade: false,
      }),
    )
  }
  if (kept.length === 0) return 'nothing'
  await d.db.transaction(async (tx) => {
    await tx.insert(persona).values(kept.map((p) => toRow(p, runId, now)))
    await tx
      .update(persona)
      .set({ active: false })
      .where(
        and(
          eq(persona.active, true),
          sql`(${persona.handmade} or ${persona.builtAt} < ${new Date(now.getTime() - OLD_DAYS * DAY_MS).toISOString()})`,
        ),
      )
  })
  return 'done'
}

/** The names of the clients of these chats, from their orders, to hide from the builder (ADR-016). */
async function clientNames(db: Db, chats: Chat[]): Promise<string[]> {
  const ids = [...new Set(chats.flatMap((c) => c.orderIds))]
  if (ids.length === 0) return []
  const rows = await db.select({ name: lead.clientName }).from(lead).where(inArray(lead.id, ids))
  return namesToHide(...rows.map((r) => r.name))
}

/** Whether the personas are due: never built, a week since the last build, or 20 new conversations since. */
async function due(db: Db, now: Date): Promise<boolean> {
  const [last] = (
    await db.execute<{ day: string }>(
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
 * A persona for a training (FR-TRAIN-3): active ones only, the topics Boris trains first, then the hardness asked
 * for, and the one used least in the last week; null when there are none.
 */
export async function pickPersona(
  db: Db,
  o: { preferTopics: Topic[]; hard: boolean },
): Promise<Persona | null> {
  const rows = await db.select().from(persona).where(eq(persona.active, true))
  if (rows.length === 0) return null
  const uses = new Map(
    (
      await db.execute<{ persona_id: string; n: number }>(sql`
        select persona_id, count(*)::int as n from core.training_session
        where persona_id is not null and started_at > now() - interval '7 days'
        group by persona_id`)
    ).rows.map((r) => [r.persona_id, r.n]),
  )
  const score = (p: (typeof rows)[number]) =>
    10 * (p.topics as Topic[]).filter((t) => o.preferTopics.includes(t)).length +
    (p.hard === o.hard ? 3 : 0) -
    2 * (uses.get(p.id) ?? 0)
  const best = [...rows].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0]
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
