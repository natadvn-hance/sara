export const TASK_ACTIONS = [
  'bid',
  'edit',
  'skip',
  'send',
  'take',
  'return',
  'done',
  'move',
  'open',
  'want',
  'apply',
  'drop',
  /** «Разбор» on a lead card: the Analyst's full reading as its own message; decides nothing. */
  'razbor',
] as const
export type TaskAction = (typeof TASK_ACTIONS)[number]

const MAX_BYTES = 64

/** C5: callback_data is `t:<task id>:<action>`, at most 64 bytes. */
export function formatCallback(taskId: string, action: TaskAction): string {
  const data = `t:${taskId}:${action}`
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES)
    throw new Error(`callback_data longer than ${MAX_BYTES} bytes`)
  return data
}

export function parseCallback(data: string): { taskId: string; action: TaskAction } | null {
  const m = /^t:([^:]+):([a-z]+)$/.exec(data)
  if (!m) return null
  const [, taskId, action] = m
  if (!taskId || !(TASK_ACTIONS as readonly string[]).includes(action ?? '')) return null
  return { taskId, action: action as TaskAction }
}
