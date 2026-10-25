import { PRIORITIES, type RoleMeta } from '@sara/shared'

export type Priority = RoleMeta['priority']

/**
 * At most `limit` holders at once; a freed slot goes to the highest priority waiting, P0 first, in arrival order.
 * P3 only orders the queue, so it also holds back: P3 holders never exceed `max(1, limit - 1)`, which with two slots
 * is one, so the work Boris waits for (P0-P2) never finds every slot taken by background runs. Whoever releases a
 * slot says which priority held it.
 */
export function createSlots(limit: number): {
  acquire(p: Priority): Promise<void>
  release(p: Priority): void
} {
  const p3Max = Math.max(1, limit - 1)
  let held = 0
  let heldP3 = 0
  const waiting = new Map<Priority, (() => void)[]>(PRIORITIES.map((p) => [p, []]))

  /** Starts waiters while a slot is free: the highest priority first, a P3 only while it is under its share. */
  function fill(): void {
    while (held < limit) {
      const next = PRIORITIES.find(
        (p) => (waiting.get(p)?.length ?? 0) > 0 && (p !== 'P3' || heldP3 < p3Max),
      )
      if (!next) return
      held++
      if (next === 'P3') heldP3++
      waiting.get(next)?.shift()?.()
    }
  }

  return {
    acquire(p) {
      return new Promise<void>((resolve) => {
        waiting.get(p)?.push(resolve)
        fill()
      })
    },
    release(p) {
      held--
      if (p === 'P3') heldP3--
      fill()
    },
  }
}
