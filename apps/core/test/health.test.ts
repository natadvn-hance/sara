import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp, type TestApp } from './helpers/app'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)
let t: TestApp

beforeEach(async () => {
  await resetDb(db)
  t = await buildTestApp(db)
  await t.app.inject({
    method: 'POST',
    url: '/api/setup/password',
    payload: { password: 'длинныйпароль1' },
  })
})
afterEach(() => t.close())

describe('system status', () => {
  it('FR-SET-5: health lists four checks with fix text for failures', async () => {
    const r = await t.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: t.cookie() },
    })
    const { checks } = r.json() as {
      checks: { id: string; ok: boolean; fix: string | null; title: string }[]
    }
    expect(checks.map((c) => c.id)).toEqual(['db', 'telegram', 'claude', 'profi'])
    expect(checks.map((c) => c.title)).toEqual(['База данных', 'Telegram', 'Claude', 'Профи.ру'])
    expect(checks.find((c) => c.id === 'db')?.ok).toBe(true)
    expect(checks.find((c) => c.id === 'profi')?.ok).toBe(true)
    const telegram = checks.find((c) => c.id === 'telegram')
    expect(telegram?.ok).toBe(false)
    expect(telegram?.fix).toBeTruthy()
  })

  it('FR-SET-5: claude check turns green after a successful probe', async () => {
    const cookie = { cookie: t.cookie() }
    await t.app.inject({
      method: 'POST',
      url: '/api/setup/claude',
      payload: { token: 'x' },
      headers: cookie,
    })
    const { checks } = (
      await t.app.inject({ method: 'GET', url: '/api/health', headers: cookie })
    ).json() as {
      checks: { id: string; ok: boolean }[]
    }
    expect(checks.find((c) => c.id === 'claude')?.ok).toBe(true)
  })
})
