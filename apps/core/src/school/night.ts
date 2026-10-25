import { MODEL_UNITS, newEventId } from '@sara/shared'
import { and, gte, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { jobRun, modelCall } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { getSetting } from '../settings/store'
import type { ModelName, NightJob, SchoolDeps } from './types'
import { withPriority } from './wrappers'

/** Moscow keeps UTC+3 all year (no daylight saving since 2014), so its wall clock is a fixed shift. */
const MSK_MS = 3 * 60 * 60_000
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
/** A limit on a model this recent keeps the night's jobs on that model away (M5 design 5.12). */
const LIMIT_LOOKBACK_MS = 12 * HOUR_MS

type Window = { from: number; to: number }

/** The Moscow date of an instant, as YYYY-MM-DD. */
const mskDate = (t: number) => new Date(t + MSK_MS).toISOString().slice(0, 10)
/** The instant of a Moscow wall-clock hour on a Moscow date. */
const mskInstant = (date: string, hour: number, minute = 0) =>
  Date.parse(`${date}T00:00:00Z`) - MSK_MS + hour * HOUR_MS + minute * 60_000

/** When tonight's window opened, or null outside it (a window may pass midnight: from 23 to 7). */
export function nightStart(now: Date, w: Window): Date | null {
  const t = now.getTime()
  const today = mskDate(t)
  const hour = new Date(t + MSK_MS).getUTCHours()
  if (w.from < w.to)
    return hour >= w.from && hour < w.to ? new Date(mskInstant(today, w.from)) : null
  if (hour >= w.from) return new Date(mskInstant(today, w.from))
  if (hour < w.to) return new Date(mskInstant(mskDate(t - DAY_MS), w.from))
  return null
}

/** The instant of a job's time in the night that opened at `start`. */
function jobInstant(start: Date, w: Window, at: NightJob['atMsk']): number {
  const startDate = mskDate(start.getTime())
  const pastMidnight = w.from > w.to && at.hour < w.from
  const date = pastMidnight ? mskDate(start.getTime() + DAY_MS) : startDate
  return mskInstant(date, at.hour, at.minute)
}

/** Units the night school has spent since tonight's window opened: P3 calls by model weight (NFR-COST-2). */
export async function nightUnitsUsed(db: Db, now: Date): Promise<number> {
  const start = nightStart(now, await getSetting(db, 'school.night'))
  if (!start) return 0
  const rows = await db
    .select({ model: modelCall.model, n: sql<number>`count(*)::int` })
    .from(modelCall)
    .where(
      and(
        sql`${modelCall.priority} = 'P3'`,
        gte(modelCall.startedAt, start.toISOString()),
        // A call that met the limit before it ran (a 0 ms stand-in row) spent nothing.
        sql`not (${modelCall.errorClass} = 'limit_reached' and ${modelCall.durationMs} = 0)`,
      ),
    )
    .groupBy(modelCall.model)
  return rows.reduce((sum, r) => sum + (MODEL_UNITS[r.model as ModelName] ?? 0) * r.n, 0)
}

/** Models that met the Claude limit in the last 12 hours. */
async function limitedModels(db: Db, now: Date): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ model: modelCall.model })
    .from(modelCall)
    .where(
      and(
        sql`${modelCall.errorClass} = 'limit_reached'`,
        gte(modelCall.startedAt, new Date(now.getTime() - LIMIT_LOOKBACK_MS).toISOString()),
      ),
    )
  return new Set(rows.map((r) => r.model))
}

/** Takes the job's row for this night; false when it was already taken (by this or another core). */
async function take(db: Db, name: string, day: string): Promise<boolean> {
  const rows = await db
    .insert(jobRun)
    .values({ name: `school:${name}`, day })
    .onConflictDoNothing()
    .returning({ day: jobRun.day })
  return rows.length > 0
}

async function journal(
  db: Db,
  type: 'school.night_ran' | 'school.night_skipped',
  job: string,
  payload: Record<string, unknown>,
) {
  await appendEvent(db, {
    type,
    v: 1,
    entity: { kind: 'school_job', id: job },
    account_id: null,
    actor: 'sara',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { job, ...payload },
  })
}

/** Whether the night that opened at `start` is the weekly one: it ends on the weekly day (Saturday to Sunday by default). */
export function isWeeklyNight(start: Date, w: Window, weeklyDay: number): boolean {
  const day = mskDate(start.getTime())
  const endDay = w.from > w.to ? mskDate(start.getTime() + DAY_MS) : day
  return new Date(`${endDay}T12:00:00Z`).getUTCDay() === weeklyDay
}

/** Why a job must not run tonight, or null: a limit on one of its models, or not enough units left. */
async function whySkip(d: SchoolDeps, job: NightJob, now: Date): Promise<string | null> {
  const limited = await limitedModels(d.db, now)
  const hit = job.models.find((m) => limited.has(m))
  if (hit) return `лимит Claude у ${hit} за последние 12 часов`
  const units =
    (await getSetting(d.db, 'school.night_units')) +
    (job.weekly ? await getSetting(d.db, 'school.weekly_units') : 0)
  const used = await nightUnitsUsed(d.db, now)
  const want = await job.estimate(d, now)
  return used + want > units ? `бюджет: потрачено ${used}, нужно ${want}, можно ${units}` : null
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : 'unknown')

/**
 * Runs the night jobs whose time has come, each once a night (M5 design 5.12): only while the school is on, never on
 * a model that met the limit in the last 12 hours, never past the night's units. A skipped or failed job takes its
 * night too, so it does not try again every minute, and never stops the jobs after it. Every call of a non-free job
 * goes as P3, so it stays behind clients and inside the counted units. The journal gets codes, never an error's text
 * (it may carry a query's values, ADR-022); a free job (the mind exchange) skips all the checks.
 */
export async function runNight(
  d: SchoolDeps,
  jobs: NightJob[],
  now: Date,
): Promise<{ ran: string[]; skipped: { name: string; reason: string }[] }> {
  const out = { ran: [] as string[], skipped: [] as { name: string; reason: string }[] }
  const w = await getSetting(d.db, 'school.night')
  const start = nightStart(now, w)
  if (!start) return out
  const day = mskDate(start.getTime())
  const weeklyNight = isWeeklyNight(start, w, await getSetting(d.db, 'school.weekly_day'))
  const on = await getSetting(d.db, 'school.on')
  const taken = new Set(
    (
      await d.db.execute<{ name: string }>(
        sql`select name from core.job_run where day = ${day} and name like 'school:%'`,
      )
    ).rows.map((r) => r.name),
  )
  const due = jobs
    .filter((j) => jobInstant(start, w, j.atMsk) <= now.getTime())
    .filter((j) => (j.weekly ? weeklyNight : !(j.notWeekly && weeklyNight)))
    .filter((j) => j.free || on)
    .filter((j) => !taken.has(`school:${j.name}`))
    .sort((a, b) => jobInstant(start, w, a.atMsk) - jobInstant(start, w, b.atMsk))

  for (const job of due) {
    const jd = job.free ? d : { ...d, gateway: withPriority(d.gateway, 'P3') }
    let reason: string | null = null
    if (!job.free) {
      try {
        reason = await whySkip(jd, job, now)
      } catch (e) {
        console.error(`school night check ${job.name} failed`, e instanceof Error ? e.message : e)
        reason = 'сбой проверки'
      }
    }
    if (!(await take(d.db, job.name, day))) continue
    if (reason) {
      out.skipped.push({ name: job.name, reason })
      await journal(d.db, 'school.night_skipped', job.name, { reason })
      continue
    }
    try {
      const result = await job.run(jd, now)
      out.ran.push(job.name)
      await journal(d.db, 'school.night_ran', job.name, { result })
    } catch (e) {
      console.error(`school night job ${job.name} failed`, e instanceof Error ? e.message : e)
      out.skipped.push({ name: job.name, reason: 'сбой задачи' })
      await journal(d.db, 'school.night_skipped', job.name, {
        reason: 'сбой задачи',
        error: errorName(e),
      })
    }
  }
  return out
}
