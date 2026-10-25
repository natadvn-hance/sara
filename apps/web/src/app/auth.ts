import { useSyncExternalStore } from 'react'

let lost = false
const listeners = new Set<() => void>()

/**
 * The core refused the Mini App's signature (older than a day, or not Boris). Every screen stops polling and the
 * shell asks to open the app again: a Mini App left open must not keep knocking with a dead signature.
 */
export function markAuthLost(): void {
  if (lost) return
  lost = true
  for (const f of listeners) f()
}

export function authLost(): boolean {
  return lost
}

export function useAuthLost(): boolean {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f)
      return () => listeners.delete(f)
    },
    () => lost,
  )
}
