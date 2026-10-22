import { newEventId, SETUP_STEPS, type SetupStep } from '@sara/shared'
import type { Db } from '../db/client'
import { appendEvent } from '../journal/journal'
import { getSetting, setSetting } from '../settings/store'

export async function setupState(
  db: Db,
): Promise<{ next: SetupStep | 'done'; completed: SetupStep[] }> {
  const { completed } = await getSetting(db, 'setup.progress')
  const ordered = SETUP_STEPS.filter((s) => completed.includes(s))
  return { next: SETUP_STEPS.find((s) => !completed.includes(s)) ?? 'done', completed: ordered }
}

export async function completeStep(db: Db, step: SetupStep): Promise<void> {
  const { completed } = await getSetting(db, 'setup.progress')
  if (completed.includes(step)) return
  await setSetting(db, 'setup.progress', { completed: [...completed, step] }, 'boris')
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
