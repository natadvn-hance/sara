import { GeneratorOutput, newEventId, type Topic } from '@sara/shared'
import { asc, eq, lt } from 'drizzle-orm'
import type { MindSearch } from '../conversation/types'
import { mindGap, persona, simDialog } from '../db/schema'
import { getSetting } from '../settings/store'
import type { NightJob, SchoolDeps } from './types'

const DAY_MS = 24 * 60 * 60_000
/** One call writes this many dialogs, one per persona (M5 design 5.11). */
const PER_CALL = 5
/** Generated client lines live this long. */
const KEEP_DAYS = 30
/**
 * A record of the line's topic among the first three hits closes the gap only with a rank this high. M4's index is
 * not built yet; the value is checked again on a sample once it is (M5 design 5.11).
 */
const GAP_RANK = 0.05
const SONNET_UNITS = 4

type ClientLine = { text: string; topic: Topic }

/** Whether the mind has no answer to a client's line: no understanding or knowledge of its topic ranked high enough. */
async function isGap(mind: MindSearch, line: ClientLine): Promise<boolean> {
  const hits = await mind.search({
    text: line.text,
    scope: 'shared',
    types: ['understanding', 'knowledge'],
    limit: 3,
  })
  return !hits.some((h) => h.topic === line.topic && h.rank >= GAP_RANK)
}

/**
 * The night's made-up dialogs (FR-TRAIN-9, M5 design 5.11): `school.generator_dialogs` dialogs, five personas a call
 * of `dialog-generator`. Only the client's lines with their topics are kept (30 days), never the specialist's side;
 * a line the mind has no answer to becomes a gap `sim:<dialog>:<n>` for the interview. A generated dialog is never
 * knowledge: the mind writer refuses a `sim:` source, and the exam and golden set builders never read these rows.
 */
export async function generateDialogs(
  d: Pick<SchoolDeps, 'db' | 'gateway' | 'mind'>,
  now: Date,
): Promise<'done' | 'nothing'> {
  await d.db
    .delete(simDialog)
    .where(lt(simDialog.createdAt, new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString()))
  const personas = await d.db
    .select()
    .from(persona)
    .where(eq(persona.active, true))
    .orderBy(asc(persona.id))
  if (personas.length === 0) return 'nothing'
  const calls = Math.ceil((await getSetting(d.db, 'school.generator_dialogs')) / PER_CALL)
  const runId = newEventId()
  for (let i = 0; i < calls; i++) {
    const batch = Array.from(
      { length: Math.min(PER_CALL, personas.length) },
      (_, k) => personas[(i * PER_CALL + k) % personas.length],
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
      // The limit stops the night's generation; another failure costs one call only.
      if (r.errorClass === 'limit_reached') break
      continue
    }
    for (const dialog of r.output.dialogs) {
      const lines: ClientLine[] = dialog.messages.flatMap((m) =>
        m.side === 'client' ? [{ text: m.text, topic: m.topic }] : [],
      )
      const id = newEventId()
      const gaps: number[] = []
      for (const [n, line] of lines.entries()) if (await isGap(d.mind, line)) gaps.push(n)
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
    }
  }
  return 'done'
}

/** The night job (03:00, sonnet): ten calls by default. */
export const generatorJob: NightJob = {
  name: 'generator',
  atMsk: { hour: 3, minute: 0 },
  models: ['sonnet'],
  estimate: async (d) =>
    Math.ceil((await getSetting(d.db, 'school.generator_dialogs')) / PER_CALL) * SONNET_UNITS,
  run: (d, now) => generateDialogs(d, now),
}
