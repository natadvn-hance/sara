import type { Db } from '../db/client'
import type { Gateway } from '../gateway/gateway'
import type { Notifier } from '../notify/notifier'
import { sweepIgnored } from './labels'

export type LearningDeps = { db: Db; notifier: Notifier; gateway: Gateway }
type Step = { name: string; run(d: LearningDeps, now: Date): Promise<unknown> }

/** The learning jobs, in order on every tick. Later tasks add the daily summary and rule proposals. */
export const LEARNING_STEPS: Step[] = [
  { name: 'ignored', run: (d, now) => sweepIgnored(d.db, now) },
]

/** Runs the learning jobs once a minute; one failing job never stops the others. */
export function startLearningJobs(d: LearningDeps & { now?: () => Date; tickMs?: number }): {
  stop(): void
  tick(): Promise<void>
} {
  const now = d.now ?? (() => new Date())
  let running: Promise<void> | null = null
  async function tick() {
    // One tick at a time: a slow job (a backtest) never overlaps the next tick.
    if (running) return running
    running = (async () => {
      for (const s of LEARNING_STEPS) {
        try {
          await s.run(d, now())
        } catch (e) {
          console.error(`learning job ${s.name} failed`, e instanceof Error ? e.message : e)
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
