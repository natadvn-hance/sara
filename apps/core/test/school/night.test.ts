import { newEventId } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, jobRun, modelCall } from '../../src/db/schema'
import { nightUnitsUsed, runNight } from '../../src/school/night'
import type { NightJob, SchoolDeps } from '../../src/school/types'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
  await setSetting(db, 'school.on', true, 'boris')
})

const d = { db } as unknown as SchoolDeps
/** A Moscow wall-clock time (UTC+3, no daylight saving). */
const msk = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`)

function job(
  name: string,
  o: Partial<NightJob> & { at?: string } = {},
): NightJob & { runs: number } {
  const [h, m] = (o.at ?? '01:00').split(':').map(Number)
  const j = {
    name,
    atMsk: { hour: h ?? 1, minute: m ?? 0 },
    models: ['sonnet'] as NightJob['models'],
    estimate: async () => 4,
    runs: 0,
    async run() {
      j.runs++
      return 'done' as const
    },
    ...o,
  }
  return j
}

async function spend(
  model: string,
  n: number,
  at: Date,
  errorClass: string | null = null,
  o: { priority?: string; durationMs?: number } = {},
) {
  for (let i = 0; i < n; i++)
    await db.insert(modelCall).values({
      id: newEventId(),
      role: 'teacher',
      roleVersion: 1,
      model,
      priority: o.priority ?? 'P3',
      startedAt: at.toISOString(),
      durationMs: o.durationMs ?? 1,
      ok: errorClass === null,
      errorClass,
    })
}

const skipped = async () =>
  (await db.select().from(event).where(eq(event.type, 'school.night_skipped'))).map(
    (e) => (e.payload as { job: string; reason: string }).job,
  )

describe('the night school', () => {
  it('NFR-COST-2: a job runs once a night inside the window', async () => {
    const teacher = job('teacher', { at: '01:15' })
    await runNight(d, [teacher], msk('2026-10-26', '00:40'))
    await runNight(d, [teacher], msk('2026-10-26', '01:10'))
    expect(teacher.runs).toBe(0)
    await runNight(d, [teacher], msk('2026-10-26', '01:16'))
    await runNight(d, [teacher], msk('2026-10-26', '03:00'))
    expect(teacher.runs).toBe(1)
    await runNight(d, [teacher], msk('2026-10-27', '01:20'))
    expect(teacher.runs).toBe(2)
    await runNight(d, [teacher], msk('2026-10-27', '08:00'))
    expect(teacher.runs).toBe(2)
  })

  it('NFR-COST-2: a job over the remaining units is skipped with the reason', async () => {
    await spend('sonnet', 99, msk('2026-10-26', '01:05'))
    // Yesterday's night, calls that are not P3 and calls stopped by the limit before they ran do not count.
    await spend('sonnet', 50, msk('2026-10-25', '02:00'))
    await spend('sonnet', 20, msk('2026-10-26', '01:10'), null, { priority: 'P1' })
    await spend('opus', 3, msk('2026-10-26', '01:10'), 'limit_reached', { durationMs: 0 })
    expect(await nightUnitsUsed(db, msk('2026-10-26', '02:00'))).toBe(396)
    const small = job('small', { at: '01:30', estimate: async () => 4 })
    const big = job('big', { at: '01:30', estimate: async () => 5 })
    const r = await runNight(d, [small, big], msk('2026-10-26', '02:00'))
    expect(small.runs).toBe(1)
    expect(big.runs).toBe(0)
    expect(r.skipped).toEqual([{ name: 'big', reason: expect.stringMatching(/^бюджет/) }])
    expect(await skipped()).toEqual(['big'])
    // A skipped job takes its night's row: it does not try again every minute.
    await runNight(d, [big], msk('2026-10-26', '02:01'))
    expect(await skipped()).toEqual(['big'])
  })

  it('NFR-COST-2: a limit on opus in the last 12 hours skips the opus jobs, not the haiku ones', async () => {
    await spend('opus', 1, msk('2026-10-25', '18:00'), 'limit_reached')
    const teacher = job('teacher', { models: ['opus'] })
    const insights = job('insights', { models: ['haiku'] })
    const r = await runNight(d, [teacher, insights], msk('2026-10-26', '01:30'))
    expect(teacher.runs).toBe(0)
    expect(insights.runs).toBe(1)
    expect(r.skipped[0]).toMatchObject({
      name: 'teacher',
      reason: expect.stringMatching(/лимит Claude у opus/),
    })
  })

  it('NFR-COST-2: a weekly job runs only on its night and gets the weekly units', async () => {
    await spend('sonnet', 100, msk('2026-10-25', '01:05'))
    const exam = job('exam', { at: '03:30', weekly: true, estimate: async () => 600 })
    const daily = job('daily', { at: '03:00', estimate: async () => 4 })
    // 25.10.2026 is a Sunday: the default weekly night ends on it.
    await runNight(d, [exam, daily], msk('2026-10-25', '04:00'))
    expect(exam.runs).toBe(1)
    expect(daily.runs).toBe(0)
    const monday = job('exam2', { at: '03:30', weekly: true, estimate: async () => 1 })
    await runNight(d, [monday], msk('2026-10-26', '04:00'))
    expect(monday.runs).toBe(0)
  })

  it('NFR-COST-2: nothing but free jobs runs while school.on is off', async () => {
    await setSetting(db, 'school.on', false, 'boris')
    const teacher = job('teacher')
    const sync = job('mindSync', { at: '05:30', free: true, models: [], estimate: async () => 999 })
    await spend('sonnet', 1, msk('2026-10-25', '23:00'), 'limit_reached')
    await runNight(d, [teacher, sync], msk('2026-10-26', '06:00'))
    expect(teacher.runs).toBe(0)
    expect(sync.runs).toBe(1)
    expect(await db.select().from(jobRun).where(eq(jobRun.name, 'school:teacher'))).toHaveLength(0)
  })

  it('NFR-COST-2: a window past midnight keeps one night from 23:00 to 07:00', async () => {
    await setSetting(db, 'school.night', { from: 23, to: 7 }, 'boris')
    const early = job('early', { at: '23:30' })
    const late = job('late', { at: '00:30' })
    await runNight(d, [early, late], msk('2026-10-25', '23:45'))
    expect([early.runs, late.runs]).toEqual([1, 0])
    await runNight(d, [early, late], msk('2026-10-26', '00:45'))
    expect([early.runs, late.runs]).toEqual([1, 1])
    const rows = await db
      .select()
      .from(jobRun)
      .where(and(eq(jobRun.name, 'school:late'), eq(jobRun.day, '2026-10-25')))
    expect(rows).toHaveLength(1)
  })

  it('NFR-COST-2: a failing job is journaled without its message and the next one still runs', async () => {
    const bad = job('bad', {
      async run() {
        throw new Error('Failed query: update core.lesson set client_text = Анна, +7 999 123-45-67')
      },
    })
    const broken = job('broken', {
      estimate: async () => {
        throw new Error('estimate broke on Анна')
      },
    })
    const good = job('good')
    const r = await runNight(d, [bad, broken, good], msk('2026-10-26', '01:30'))
    expect(good.runs).toBe(1)
    expect(r.ran).toEqual(['good'])
    expect(r.skipped).toEqual([
      { name: 'bad', reason: 'сбой задачи' },
      { name: 'broken', reason: 'сбой проверки' },
    ])
    const payloads = JSON.stringify((await db.select().from(event)).map((e) => e.payload))
    expect(payloads).not.toContain('Анна')
    expect(payloads).not.toContain('999')
  })

  it('NFR-COST-2: a job that ran is not checked again the same night', async () => {
    let estimated = 0
    const teacher = job('teacher', {
      estimate: async () => {
        estimated++
        return 4
      },
    })
    for (const at of ['01:10', '01:11', '02:00'])
      await runNight(d, [teacher], msk('2026-10-26', at))
    expect(teacher.runs).toBe(1)
    expect(estimated).toBe(1)
  })

  it('NFR-COST-2: every call of a night job goes as P3', async () => {
    const priorities: (string | undefined)[] = []
    const gw = {
      call: async (_r: unknown, _i: unknown, _s: unknown, o?: { priority?: string }) => {
        priorities.push(o?.priority)
        return {
          ok: false,
          errorClass: 'limit_reached',
          message: '',
          durationMs: 0,
          modelCallId: 'x',
        }
      },
    }
    const caller = job('caller', {
      async run(jd) {
        await jd.gateway.call('interlocutor', 'x', { parse: (v: unknown) => v } as never, {
          priority: 'P0',
        })
        return 'done'
      },
    })
    await runNight(
      { ...d, gateway: gw } as unknown as SchoolDeps,
      [caller],
      msk('2026-10-26', '01:30'),
    )
    expect(priorities).toEqual(['P3'])
  })

  it('NFR-COST-2: a limit 13 hours ago no longer skips, and a free job ignores the limit', async () => {
    await spend('opus', 1, msk('2026-10-25', '12:00'), 'limit_reached')
    const teacher = job('teacher', { models: ['opus'] })
    await runNight(d, [teacher], msk('2026-10-26', '01:30'))
    expect(teacher.runs).toBe(1)
    await spend('sonnet', 1, msk('2026-10-26', '01:00'), 'limit_reached')
    const sync = job('mindSync', { at: '05:30', free: true, models: ['sonnet'] })
    await runNight(d, [sync], msk('2026-10-26', '05:31'))
    expect(sync.runs).toBe(1)
  })

  it('FR-TRAIN-8: a job kept off the weekly night does not run on it', async () => {
    const golden = job('golden', { notWeekly: true })
    // 25.10.2026 is a Sunday: the weekly night by default.
    await runNight(d, [golden], msk('2026-10-25', '02:00'))
    expect(golden.runs).toBe(0)
    await runNight(d, [golden], msk('2026-10-26', '02:00'))
    expect(golden.runs).toBe(1)
  })
})
