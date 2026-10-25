import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type PlaywrightWorkerArgs } from '@playwright/test'

export const PASSWORD = 'длинныйпароль1'

/** The signed-in state file the pult specs share: the core allows 5 logins a minute from one address. */
export const SESSION_STATE = join(tmpdir(), 'sara-e2e-pult-state.json')

/** Sets the password (the first spec to run) or signs in, and keeps the cookie in `SESSION_STATE`. */
export async function signIn(playwright: PlaywrightWorkerArgs['playwright']): Promise<void> {
  const api = await playwright.request.newContext({
    baseURL: 'http://127.0.0.1:5174',
    storageState: { cookies: [], origins: [] },
  })
  const first = await api.post('/api/setup/password', { data: { password: PASSWORD } })
  if (first.status() === 409) {
    const login = await api.post('/api/login', { data: { password: PASSWORD } })
    expect(login.ok()).toBe(true)
  }
  await api.storageState({ path: SESSION_STATE })
  await api.dispose()
}
