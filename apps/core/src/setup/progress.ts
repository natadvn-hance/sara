import { newEventId, SETUP_STEPS, type SetupStep } from '@sara/shared'
import type { Db } from '../db/client'
import { appendEvent } from '../journal/journal'
import { getSetting, setSetting } from '../settings/store'

export async function setupState(
  db: Db,
): Promise<{ next: SetupStep | 'done'; completed: SetupStep[] }> {
  const { completed, later } = await getSetting(db, 'setup.progress')
  const ordered = SETUP_STEPS.filter((s) => completed.includes(s))
  const next = SETUP_STEPS.find((s) => !completed.includes(s) && !later.includes(s)) ?? 'done'
  return { next, completed: ordered }
}

export async function completeStep(db: Db, step: SetupStep): Promise<void> {
  const progress = await getSetting(db, 'setup.progress')
  if (progress.completed.includes(step)) return
  await setSetting(
    db,
    'setup.progress',
    { completed: [...progress.completed, step], later: progress.later.filter((s) => s !== step) },
    'boris',
  )
  await appendEvent(db, {
    type: 'setup.step_completed',
    v: 1,
    entity: { kind: 'setup', id: step },
    account_id: null,
    actor: 'boris',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { step },
  })
}

/** A step Boris chose to do later: the wizard moves on, the step stays open (FR-SET-1). */
export async function postponeStep(db: Db, step: SetupStep): Promise<void> {
  const progress = await getSetting(db, 'setup.progress')
  if (progress.later.includes(step) || progress.completed.includes(step)) return
  await setSetting(db, 'setup.progress', { ...progress, later: [...progress.later, step] }, 'boris')
}
