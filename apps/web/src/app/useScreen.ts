import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { ApiError, api, go } from '../api'
import { authLost, useAuthLost } from './auth'
import { insideTelegram } from './telegram'

/** How often an open screen reads its data again (v1's app did the same). */
export const POLL_MS = 20_000

/**
 * The data of one screen: read through the API, checked by the shared schema when one is given, read again every
 * 20 seconds while the screen is visible. `pauseWhile` holds the refresh (Boris is typing, a redraw would wipe it).
 * A lost session goes to the login page in a browser; in the Mini App the shell asks to reopen the app.
 */
export function useScreen<T>(
  key: readonly unknown[],
  path: string,
  schema?: { parse(data: unknown): T },
  opts: { pauseWhile?: () => boolean } = {},
) {
  const lost = useAuthLost()
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const data = await api<unknown>(path)
      return schema ? schema.parse(data) : (data as T)
    },
    retry: false,
    enabled: !lost,
    refetchInterval: () =>
      authLost() || document.visibilityState !== 'visible' || opts.pauseWhile?.() ? false : POLL_MS,
  })
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 401 && !insideTelegram()) go('/login')
  }, [q.error])
  return q
}
