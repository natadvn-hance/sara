import type { CheckInput, CheckIssue } from '../types'

/** The code checks of a reply (FR-CONV-4). Part D writes the body; until then nothing passes. */
export function checkReplyText(_i: CheckInput): CheckIssue[] {
  return [{ id: 'empty', detail: 'проверка ещё не построена' }]
}

/** Whether the last message from our side was on an earlier Moscow day (null: there was none). Part D. */
export function isNewMoscowDay(_lastOursAt: string | null, _now: Date): boolean {
  return true
}
