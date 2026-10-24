import { eq, inArray } from 'drizzle-orm'
import { directionRun } from '../db/schema'
import { recomputeProcess } from './recompute'
import { finishRun, getRun } from './runStore'
import { ClaudeLimitError, type TrialDeps } from './trial'

export { createRun, getRun, type NewRun, type RunKind, type RunRow } from './runStore'

/**
 * Scores a run's leads one at a time, saving progress after each. Scores already in the cache cost nothing, so a
 * restart simply runs it again from the start. The Claude limit stops the run with a reason; any other failure
 * of the run itself marks it failed, so the next one can start.
 */
export async function runWorker(
  d: TrialDeps,
  runId: string,
  o: { onProgress?: (done: number) => void } = {},
): Promise<void> {
  const run = await getRun(d.db, runId)
  if (!run || (run.state !== 'queued' && run.state !== 'running')) return
  await d.db.update(directionRun).set({ state: 'running' }).where(eq(directionRun.id, runId))
  const ids = run.leadIds as string[]
  let skipped = 0
  try {
    for (const [i, leadId] of ids.entries()) {
      const r = run.kind === 'recompute' ? await recomputeProcess(d, run, leadId) : 'ok'
      if (r === 'miss') skipped++
      await d.db
        .update(directionRun)
        .set({ done: i + 1, skipped })
        .where(eq(directionRun.id, runId))
      o.onProgress?.(i + 1)
    }
    await finishRun(d.db, run, 'done', null)
  } catch (e) {
    if (e instanceof ClaudeLimitError) return finishRun(d.db, run, 'stopped', 'limit')
    console.error('direction run failed', e instanceof Error ? e.message.slice(0, 200) : e)
    await finishRun(d.db, run, 'failed', 'error')
  }
}

/** On start: runs a restart cut off go on in the background, one after the other. */
export async function resumeRuns(d: TrialDeps): Promise<void> {
  const rows = await d.db
    .select({ id: directionRun.id })
    .from(directionRun)
    .where(inArray(directionRun.state, ['queued', 'running']))
    .orderBy(directionRun.createdAt)
  void (async () => {
    for (const r of rows) await runWorker(d, r.id)
  })()
}
