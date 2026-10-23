import { DBOS } from '@dbos-inc/dbos-sdk'
import type { TaskAction } from '@sara/shared'

const TOPIC = 'decision'
const WEEK_SECONDS = 7 * 24 * 3600

let reminderHandler: (taskId: string) => Promise<void> = async () => {}

export function setReminderHandler(h: (taskId: string) => Promise<void>): void {
  reminderHandler = h
}

const workflowId = (taskId: string) => `decision:${taskId}`

/** Waits for Boris's decision; if none comes in time, reminds once and keeps waiting. */
async function decisionWait(taskId: string, remindAfterMs: number): Promise<TaskAction | null> {
  const first = await DBOS.recv<TaskAction>(TOPIC, { timeoutSeconds: remindAfterMs / 1000 })
  if (first !== null) return first
  await DBOS.runStep(() => reminderHandler(taskId), { name: 'remind' })
  return DBOS.recv<TaskAction>(TOPIC, { timeoutSeconds: WEEK_SECONDS })
}

const decisionWaitWorkflow = DBOS.registerWorkflow(decisionWait, { name: 'decisionWait' })

export async function startDecisionWait(taskId: string, remindAfterMs: number): Promise<void> {
  await DBOS.startWorkflow(decisionWaitWorkflow, { workflowID: workflowId(taskId) })(
    taskId,
    remindAfterMs,
  )
}

/** Ends the wait for this task; a task without a running wait (already finished or never started) is fine. */
export async function deliverDecision(taskId: string, resolution: TaskAction): Promise<void> {
  try {
    await DBOS.send(workflowId(taskId), resolution, TOPIC, `decision:${taskId}:${resolution}`)
  } catch (e) {
    if ((e as Error).name !== 'DBOSNonExistentWorkflowError') throw e
  }
}
