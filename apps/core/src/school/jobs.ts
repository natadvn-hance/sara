import { cleanSimStep, generatorJob } from './generator'
import { runNight } from './night'
import { personasJob } from './trainer/personas'
import type { NightJob, SchoolDeps } from './types'

type Step = { name: string; run(d: SchoolDeps, now: Date): Promise<unknown> }

/** The night school's jobs (M5 design 5.12); the parts add theirs. */
export const NIGHT_JOBS: NightJob[] = [personasJob, generatorJob]

/** The school's jobs, in order on every tick; the parts add theirs. */
export const SCHOOL_STEPS: Step[] = [
  { name: 'night', run: (d, now) => runNight(d, NIGHT_JOBS, now) },
  // Generated lines go after 30 days even on nights the generator does not run.
  { name: 'simCleanup', run: (d, now) => cleanSimStep(d.db, now) },
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
