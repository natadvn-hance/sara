// Test helper process: launches DBOS, waits for a decision and records reminders as events.

import { newEventId } from '@sara/shared'
import { appendEvent } from '../../src/journal/journal'
import { launchDbos } from '../../src/workflows/dbos'
import {
  deliverDecision,
  setReminderHandler,
  startDecisionWait,
} from '../../src/workflows/decisionWait'
import { openTestDb, testDatabaseUrl } from '../helpers/db'

const [taskId = '', remindAfterMs = '3000', deliverAfterMs] = process.argv.slice(2)
const { db } = openTestDb()
setReminderHandler(async (id) => {
  await appendEvent(db, {
    type: 'task.reminded',
    v: 1,
    entity: { kind: 'task', id },
    account_id: null,
    actor: 'sara',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: {},
  })
})
if (process.env.WORKER_CHANGED_CODE === '1') {
  // Simulates a deploy: one more registered workflow changes the code DBOS sees.
  const { DBOS } = await import('@dbos-inc/dbos-sdk')
  DBOS.registerWorkflow(async () => 'new', { name: 'addedInNextRelease' })
}
await launchDbos(testDatabaseUrl())
await startDecisionWait(taskId, Number(remindAfterMs))
console.log('started')
if (deliverAfterMs) {
  setTimeout(() => void deliverDecision(taskId, 'bid'), Number(deliverAfterMs))
}
