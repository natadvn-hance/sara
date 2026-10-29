import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ApiError, api, authHeaders, go } from '../api'

/** While the live stream is connected the screens are read again only once a minute; without it every 20 seconds. */
let streamOn = false

/**
 * The key of every pult screen's data: the live stream reads these again and nothing else. The pages of the rules
 * (M3) keep their own data and their own moment to read it; a refresh from outside could overwrite a step just
 * saved with an answer that was already on its way.
 */
export const screenKey = (path: string | null) => ['screen', path] as const

/**
 * One screen's data: read at once, again every 20 seconds while the page is seen (60 with the live stream) and
 * right after any action (pult v2 design 6). A lost session goes to the login page.
 */
export function useScreen<T>(path: string | null, pollMs = 20_000) {
  const q = useQuery({
    queryKey: screenKey(path),
    queryFn: () => api<T>(path as string),
    enabled: path !== null,
    refetchInterval: streamOn ? Math.max(pollMs, 60_000) : pollMs,
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

/**
 * The live stream (`GET /api/stream`, SSE): each event of the core reads the open screens again, so a new lead or
 * a client's message shows without a reload. Read with fetch, so the Mini App's header goes along. When the stream
 * is not there, the polling above is the way, as before.
 */
export function useLive(): void {
  const client = useQueryClient()
  useEffect(() => {
    if (typeof window === 'undefined' || !('ReadableStream' in window)) return
    const abort = new AbortController()
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const connect = async () => {
      try {
        const res = await fetch('/api/stream', {
          headers: { accept: 'text/event-stream', ...authHeaders() },
          credentials: 'same-origin',
          signal: abort.signal,
        })
        if (!res.ok || !res.body) throw new Error(String(res.status))
        streamOn = true
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let last = 0
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''
          if (parts.some((p) => p.startsWith('data:')) && Date.now() - last > 1500) {
            last = Date.now()
            void client.invalidateQueries({ queryKey: ['screen'] })
          }
        }
      } catch {
        // No stream (an old core, the demo, no network): the polling carries on.
      }
      streamOn = false
      if (!stopped) timer = setTimeout(connect, 15_000)
    }
    void connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      abort.abort()
    }
  }, [client])
}
