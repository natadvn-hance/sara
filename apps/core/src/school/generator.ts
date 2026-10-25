import { GeneratorOutput, newEventId, normalizeText, type Topic } from '@sara/shared'
import { and, asc, eq, isNull, like, lt } from 'drizzle-orm'
import type { MindSearch } from '../conversation/types'
import type { Db } from '../db/client'
import { jobRun, mindGap, persona, simDialog } from '../db/schema'
import { getSetting } from '../settings/store'
import type { NightJob, SchoolDeps } from './types'

const MSK_MS = 3 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
/** One call writes this many dialogs, one per persona (M5 design 5.11). */
const PER_CALL = 5
/** A persona gets at most this many dialogs a night: with few personas the night makes fewer calls. */
const PER_PERSONA = 2
/** Generated client lines, and the gaps nobody asked about, live this long. */
const KEEP_DAYS = 30
/** At most this many new gaps a night: the interview asks one a day, the rest would only pile up. */
const MAX_GAPS = 30
/** Two failed calls in a row end the night's generation (ten timeouts would hold the school's tick for long). */
const MAX_FAILS = 2
/**
 * A record of the line's topic among the first three hits closes the gap only with a rank this high. M4's index is
 * not built yet; the value is to be checked on a sample once it is (M5 design 5.11).
 */
const GAP_RANK = 0.05
const SONNET_UNITS = 4

type ClientLine = { text: string; topic: Topic }

const mskDay = (t: number) => new Date(t + MSK_MS).toISOString().slice(0, 10)

/**
 * Whether the mind has no answer to a client's line: no understanding or knowledge of its topic among the first three
 * hits, ranked high enough, in the shared mind or in any direction's.
 */
async function isGap(mind: MindSearch, scopes: string[], line: ClientLine): Promise<boolean> {
  for (const scope of scopes) {
    const hits = await mind.search({
      text: line.text,
      scope,
      types: ['understanding', 'knowledge'],
      limit: 3,
    })
    if (hits.slice(0, 3).some((h) => h.topic === line.topic && h.rank >= GAP_RANK)) return false
  }
  return true
}

/**
 * Generated lines older than 30 days go, and so do their gaps nobody asked about (no question, no lesson): the
 * generated text is kept no longer than the dialog it came from.
 */
export async function cleanSim(db: Db, now: Date): Promise<void> {
  const before = new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString()
  await db.delete(simDialog).where(lt(simDialog.createdAt, before))
  await db
    .delete(mindGap)
    .where(
      and(
        like(mindGap.turnId, 'sim:%'),
        isNull(mindGap.questionId),
        isNull(mindGap.lessonId),
        lt(mindGap.createdAt, before),
      ),
    )
}

/** The cleanup once a day, whatever the night school did (a skipped night never keeps old lines). */
export async function cleanSimStep(db: Db, now: Date): Promise<void> {
  const day = mskDay(now.getTime())
  const [done] = await db
    .select({ name: jobRun.name })
    .from(jobRun)
    .where(and(eq(jobRun.name, 'sim_cleaned'), eq(jobRun.day, day)))
  if (done) return
  await cleanSim(db, now)
  await db.insert(jobRun).values({ name: 'sim_cleaned', day }).onConflictDoNothing()
}

/**
 * The night's made-up dialogs (FR-TRAIN-9, M5 design 5.11): `school.generator_dialogs` dialogs, five personas a call
 * of `dialog-generator`, at most two dialogs a persona, the rotation moving on each night. Only the client's lines with
 * their topics are kept (30 days), never the specialist's side. A line the mind has no answer to becomes a gap
 * `sim:<dialog>:<n>` for the interview: not while the mind is empty, not twice for the same words, at most 30 a night.
 * A generated dialog is never knowledge: the mind writer refuses a `sim:` source, and the exam and golden set
 * builders never read these rows.
 */
export async function generateDialogs(
  d: Pick<SchoolDeps, 'db' | 'gateway' | 'mind' | 'accountIds'>,
  now: Date,
): Promise<'done' | 'nothing'> {
  await cleanSim(d.db, now)
  const personas = await d.db
    .select()
    .from(persona)
    .where(eq(persona.active, true))
    .orderBy(asc(persona.id))
  if (personas.length === 0) return 'nothing'
  const wanted = Math.ceil((await getSetting(d.db, 'school.generator_dialogs')) / PER_CALL)
  const calls = Math.min(wanted, Math.ceil((personas.length * PER_PERSONA) / PER_CALL))
  const size = Math.min(PER_CALL, personas.length)
  // Each night starts where the last left off, so no persona is never played.
  const start = (Math.floor(now.getTime() / DAY_MS) * calls * size) % personas.length
  const lookForGaps = (await d.mind.version()) !== 'empty'
  const scopes = d.accountIds.length > 0 ? d.accountIds : ['shared']
  const seen = new Set(
    (await d.db.select({ text: mindGap.text }).from(mindGap).where(isNull(mindGap.lessonId))).map(
      (g) => normalizeText(g.text),
    ),
  )
  const runId = newEventId()
  let stored = 0
  let gapsMade = 0
  let fails = 0
  for (let i = 0; i < calls; i++) {
    const batch = Array.from(
      { length: size },
      (_, k) => personas[(start + i * size + k) % personas.length],
    ).filter((p) => !!p)
    const input = JSON.stringify(
      batch.map((p) => ({
        id: p.id,
        archetype: p.archetype,
        niche: p.niche,
        task: p.task,
        mood: p.mood,
        style: p.style,
        questions: p.questions,
        topics: p.topics,
        order: p.order,
        hard: p.hard,
      })),
      null,
      2,
    )
    const r = await d.gateway.call('dialog-generator', input, GeneratorOutput, {
      priority: 'P3',
      limitWaitMs: 0,
    })
    if (!r.ok) {
      // The limit ends the night's generation; two failures in a row too.
      if (r.errorClass === 'limit_reached' || ++fails >= MAX_FAILS) break
      continue
    }
    fails = 0
    for (const dialog of r.output.dialogs) {
      const lines: ClientLine[] = dialog.messages.flatMap((m) =>
        m.side === 'client' ? [{ text: m.text, topic: m.topic }] : [],
      )
      const id = newEventId()
      const gaps: number[] = []
      if (lookForGaps)
        for (const [n, line] of lines.entries()) {
          const words = normalizeText(line.text)
          if (gapsMade + gaps.length >= MAX_GAPS || seen.has(words)) continue
          if (await isGap(d.mind, scopes, line)) {
            gaps.push(n)
            seen.add(words)
          }
        }
      await d.db.transaction(async (tx) => {
        await tx.insert(simDialog).values({
          id,
          runId,
          personaId: batch.some((p) => p.id === dialog.persona_id) ? dialog.persona_id : null,
          clientMessages: lines,
          gaps,
        })
        if (gaps.length > 0)
          await tx.insert(mindGap).values(
            gaps.map((n) => ({
              id: newEventId(),
              turnId: `sim:${id}:${n}`,
              text: lines[n]?.text ?? '',
              topic: lines[n]?.topic ?? null,
            })),
          )
      })
      stored++
      gapsMade += gaps.length
    }
  }
  return stored > 0 ? 'done' : 'nothing'
}

/** The night job (03:00, sonnet): ten calls by default, fewer with few personas. */
export const generatorJob: NightJob = {
  name: 'generator',
  atMsk: { hour: 3, minute: 0 },
  models: ['sonnet'],
  estimate: async (d) =>
    Math.ceil((await getSetting(d.db, 'school.generator_dialogs')) / PER_CALL) * SONNET_UNITS,
  run: (d, now) => generateDialogs(d, now),
}
