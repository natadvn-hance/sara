import { type DirectionRules, newEventId } from '@sara/shared'
import { eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { directionRun } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { rulesHash } from './hash'

/** How long a run may go without a sign of life before the next one may start anyway. */
export const STALE_RUNNING_MIN = 30
export const STALE_QUEUED_HOURS = 3

export type RunKind = 'recompute' | 'calibration'
export type RunRow = typeof directionRun.$inferSelect

export type NewRun = {
  accountId: string
  kind: RunKind
  rules: DirectionRules
  baseRules: DirectionRules | null
  leadIds: string[]
  seed?: number
}

/** A run starts only when none is waiting or running: they share the model's slots with the live work. */
export async function createRun(
  db: Db,
  a: NewRun,
): Promise<{ ok: true; id: string } | { ok: false; error: 'busy' }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('direction_run'))`)
    // A run whose worker died (a crash, a failed write) must not block every later one: running ones are given
    // half an hour without a sign of life, ones waiting for their turn a few hours.
    await tx.execute(sql`
      update core.direction_run set state = 'failed', stop_reason = 'stale', finished_at = now()
      where (state = 'running' and updated_at < now() - make_interval(mins => ${STALE_RUNNING_MIN}))
         or (state = 'queued' and updated_at < now() - make_interval(hours => ${STALE_QUEUED_HOURS}))`)
    const [busy] = await tx
      .select({ id: directionRun.id })
      .from(directionRun)
      .where(inArray(directionRun.state, ['queued', 'running']))
      .limit(1)
    if (busy) return { ok: false as const, error: 'busy' as const }
    const id = newEventId()
    await tx.insert(directionRun).values({
      id,
      accountId: a.accountId,
      kind: a.kind,
      rules: a.rules,
      rulesHash: rulesHash(a.rules),
      baseRules: a.baseRules,
      baseHash: a.baseRules ? rulesHash(a.baseRules) : null,
      leadIds: a.leadIds,
      seed: a.seed ?? 0,
      total: a.leadIds.length,
    })
    return { ok: true as const, id }
  })
}

export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  const [row] = await db.select().from(directionRun).where(eq(directionRun.id, id))
  return row ?? null
}

export async function finishRun(
  db: Db,
  run: RunRow,
  state: 'done' | 'stopped' | 'failed',
  stopReason: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(directionRun)
      .set({ state, stopReason, finishedAt: new Date().toISOString() })
      .where(eq(directionRun.id, run.id))
    await appendEvent(tx, {
      type: 'direction.run_finished',
      v: 1,
      entity: { kind: 'direction_run', id: run.id },
      account_id: run.accountId,
      actor: 'system',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: newEventId(),
      reason: stopReason,
      payload: { kind: run.kind, state, total: run.total },
    })
  })
}
