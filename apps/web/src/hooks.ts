import { useState } from 'react'
import { ApiError, go } from './api'

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
      if (e instanceof ApiError && e.status === 401) return go('/login')
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
