import { getSetting } from '../settings/store'
import { interviewStep } from './interview'
import { batchesStep, revertPending, writePending } from './lessons/batches'
import { historyCards, importMind } from './lessons/history'
import { runNight } from './night'
import { syncNoticeStep } from './syncNotice'
import type { NightJob, SchoolDeps } from './types'

type Step = { name: string; run(d: SchoolDeps, now: Date): Promise<unknown> }

/** The night school's jobs (M5 design 5.12); the parts add theirs. */
export const NIGHT_JOBS: NightJob[] = [
  {
    // The exchange of the mind with GitHub (ADR-025): no model, so no budget, limit or school.on.
    name: 'mindSync',
    atMsk: { hour: 5, minute: 30 },
    models: [],
    free: true,
    estimate: async () => 0,
    async run(d) {
      const r = await d.writer.sync()
      // «no key» is a server without a push key (plan B4): nothing to tell. Anything else marks the night failed.
      if (r.error && r.error !== 'no key') throw new Error('mind sync failed')
      return 'done'
    },
  },
]

/** A step that does nothing while the school is off. */
const whenOn =
  (run: Step['run']): Step['run'] =>
  async (d, now) => {
    if (await getSetting(d.db, 'school.on')) await run(d, now)
  }

/**
 * The school's jobs, in order on every tick; the parts add theirs. Each is its own step, so one failing never stops
 * the others; the batch goes before the history card (M5 design 5.16, the order of importance).
 */
export const SCHOOL_STEPS: Step[] = [
  { name: 'night', run: (d, now) => runNight(d, NIGHT_JOBS, now) },
  { name: 'writePending', run: whenOn((d) => writePending(d)) },
  // «Отменить» Boris pressed runs even with the school off: taking a record back never waits.
  { name: 'revertPending', run: (d) => revertPending(d) },
  { name: 'batches', run: (d, now) => batchesStep(d, now) },
  { name: 'historyCards', run: whenOn((d, now) => historyCards(d, now)) },
  { name: 'importMind', run: whenOn((d) => importMind(d)) },
  { name: 'syncNotice', run: (d, now) => syncNoticeStep(d, now) },
  { name: 'interview', run: (d, now) => interviewStep(d, now) },
]

/** Runs the school's jobs once a minute; one failing job never stops the others (as learning/jobs.ts). */
export function startSchoolJobs(d: SchoolDeps & { now?: () => Date; tickMs?: number }): {
  stop(): void
  tick(): Promise<void>
} {
  const now = d.now ?? (() => new Date())
  let running: Promise<void> | null = null
  async function tick() {
    // One tick at a time: a slow night job never overlaps the next tick.
    if (running) return running
    running = (async () => {
      for (const s of SCHOOL_STEPS) {
        try {
          await s.run(d, now())
        } catch (e) {
          console.error(`school job ${s.name} failed`, e instanceof Error ? e.message : e)
        }
      }
    })().finally(() => {
      running = null
    })
    return running
  }
  const timer = setInterval(() => void tick(), d.tickMs ?? 60_000)
  return { stop: () => clearInterval(timer), tick }
}
