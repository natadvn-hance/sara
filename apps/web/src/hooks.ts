import { useState } from 'react'
import { ApiError, go } from './api'
import { insideTelegram } from './app/telegram'

/** One action at a time with its error text; a lost session goes to the login page. */
export function useAction() {
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  async function run(f: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await f()
    } catch (e) {
      // In the Mini App the shell asks to reopen the app instead (there is no password page there).
      if (e instanceof ApiError && e.status === 401)
        return insideTelegram() ? undefined : go('/login')
      setError({
        message: e instanceof Error ? e.message : String(e),
        code: e instanceof ApiError ? e.code : undefined,
      })
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, run, clear: () => setError(null) }
}
