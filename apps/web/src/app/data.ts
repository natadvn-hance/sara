import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ApiError, api, go } from '../api'

/**
 * One screen's data: read at once, again every 20 seconds while the page is seen and right after any action
 * (M7 design 2). A lost session goes to the login page.
 */
export function useScreen<T>(path: string | null, pollMs = 20_000) {
  const q = useQuery({
    queryKey: [path],
    queryFn: () => api<T>(path as string),
    enabled: path !== null,
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  })
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 401) go('/login')
  }, [q.error])
  return q
}

/** The toast: one short line after an action, the words the core answered. */
let toastText: string | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

export function toast(text: string | null): void {
  toastText = text
  clearTimeout(toastTimer)
  if (text) toastTimer = setTimeout(() => toast(null), 6000)
  for (const l of listeners) l()
}

export function useToast(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => toastText,
  )
}

/** A press of the pult: the core's answer goes to the toast and every screen is read again. */
export function usePress() {
  const client = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  async function press(key: string, path: string, body: unknown = {}): Promise<boolean> {
    setBusy(key)
    try {
      const r = await api<{ message: string }>(path, body)
      toast(r.message)
      return true
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) go('/login')
      else toast(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(null)
      await client.invalidateQueries()
    }
  }
  return { press, busy }
}
