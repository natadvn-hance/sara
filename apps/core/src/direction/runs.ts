import { eq, inArray } from 'drizzle-orm'
import { directionRun } from '../db/schema'
import { loadRole } from '../gateway/roles'
import { calibrationProcess } from './calibration'
import { recomputeProcess } from './recompute'
import { finishRun, getRun, type RunRow } from './runStore'
import { ClaudeStopError, type TrialDeps } from './trial'

export { createRun, getRun, type NewRun, type RunKind, type RunRow } from './runStore'

const quietly = async (what: string, f: () => Promise<unknown>) => {
  try {
    await f()
  } catch (e) {
    console.error(what, e instanceof Error ? e.message.slice(0, 200) : e)
  }
}

/**
 * Scores a run's leads one at a time, saving progress after each. Scores already in the cache cost nothing, so a
 * restart simply runs it again from the start. Claude not answering (the limit, no token) stops the run with that
 * reason; a run that scored nothing is failed, not «done»; any failure of the run itself marks it failed, so the
 * next one can start. It never rejects: it runs in the background, where a rejection would take the core down.
 */
export async function runWorker(
  d: TrialDeps,
  runId: string,
  o: { onProgress?: (done: number) => void } = {},
): Promise<void> {
  let run: RunRow | null = null
  try {
    run = await getRun(d.db, runId)
    if (!run || (run.state !== 'queued' && run.state !== 'running')) return
    const version = run.scorerVersion ?? (await loadRole(d.rolesDir, 'scorer')).meta.version
    run = { ...run, scorerVersion: version }
    await d.db
      .update(directionRun)
      .set({ state: 'running', scorerVersion: version, updatedAt: new Date().toISOString() })
      .where(eq(directionRun.id, runId))
    const ids = run.leadIds as string[]
    let skipped = 0
    for (const [i, leadId] of ids.entries()) {
      const r =
        run.kind === 'recompute'
          ? await recomputeProcess(d, run, leadId)
          : await calibrationProcess(d, run, leadId)
      if (r === 'miss') skipped++
      await d.db
        .update(directionRun)
        .set({ done: i + 1, skipped, updatedAt: new Date().toISOString() })
        .where(eq(directionRun.id, runId))
      o.onProgress?.(i + 1)
    }
    if (ids.length > 0 && skipped === ids.length)
      return await finishRun(d.db, run, 'failed', 'nothing_scored')
    await finishRun(d.db, run, 'done', null)
  } catch (e) {
    const closing = run
    if (closing && e instanceof ClaudeStopError)
      return quietly('direction run could not be closed', () =>
        finishRun(d.db, closing, 'stopped', e.reason),
      )
    console.error('direction run failed', e instanceof Error ? e.message.slice(0, 200) : e)
    if (closing)
      await quietly('direction run could not be closed', () =>
        finishRun(d.db, closing, 'failed', 'error'),
      )
  }
}

/** Runs go one after the other, in the order they are scheduled, so two never share the model's slots. */
let chain: Promise<void> = Promise.resolve()
export function scheduleRun(d: TrialDeps, runId: string): void {
  // runWorker never rejects; the catch is for what must never happen.
  chain = chain
    .then(() => runWorker(d, runId))
    .catch((e) => console.error('direction run crashed', e))
}

/** On start: runs a restart cut off go on in the background, one after the other; nothing here may reject. */
export async function resumeRuns(d: TrialDeps): Promise<void> {
  let rows: { id: string }[] = []
  try {
    rows = await d.db
      .select({ id: directionRun.id })
      .from(directionRun)
      .where(inArray(directionRun.state, ['queued', 'running']))
      .orderBy(directionRun.createdAt)
  } catch (e) {
    console.error(
      'direction runs could not be listed',
      e instanceof Error ? e.message.slice(0, 200) : e,
    )
    return
  }
  for (const r of rows) scheduleRun(d, r.id)
}
