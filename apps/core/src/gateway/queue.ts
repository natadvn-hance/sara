import { PRIORITIES, type RoleMeta } from '@sara/shared'

export type Priority = RoleMeta['priority']

/** At most `limit` holders at once; a freed slot goes to the highest priority waiting, P0 first, in arrival order. */
export function createSlots(limit: number): {
  acquire(p: Priority): Promise<void>
  release(): void
} {
  let held = 0
  const waiting = new Map<Priority, (() => void)[]>(PRIORITIES.map((p) => [p, []]))
  return {
    async acquire(p) {
      if (held < limit) {
        held++
        return
      }
      await new Promise<void>((r) => waiting.get(p)?.push(r))
    },
    release() {
      for (const p of PRIORITIES) {
        const next = waiting.get(p)?.shift()
        if (next) return next()
      }
      held--
    },
  }
}
