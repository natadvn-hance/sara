import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp, type TestApp, type TestHealth } from './helpers/app'
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

describe('Profi.ru check per account', () => {
  it('FR-SET-5: health shows the account IP and how many events wait in the queue', async () => {
    await t.close()
    const health: { current: TestHealth } = {
      current: {
        alive: true,
        balance_rub: 5000,
        presence: true,
        egress_ip: '127.0.0.1',
        queued_events: 3,
        eyes_seeing: true,
      },
    }
    t = await buildTestApp(db, {}, health)
    await t.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'длинныйпароль1' },
    })
    const read = async () =>
      (
        (
          await t.app.inject({ method: 'GET', url: '/api/health', headers: { cookie: t.cookie() } })
        ).json() as {
          checks: { id: string; ok: boolean; detail: string; fix: string | null }[]
        }
      ).checks.find((c) => c.id === 'profi')
    expect(await read()).toMatchObject({
      ok: true,
      detail: 'Сессия жива, IP 127.0.0.1 свой, в очереди к ядру 3',
    })
    health.current = { ...health.current, egress_ip: '203.0.113.9' }
    expect(await read()).toMatchObject({
      ok: false,
      detail: 'Вкладка выходит в сеть с чужого IP 203.0.113.9',
    })
    health.current = { ...health.current, egress_ip: '127.0.0.1', eyes_seeing: false }
    expect(await read()).toMatchObject({
      ok: false,
      detail: 'Сессия жива, но глаза не видят: 10 минут ничего не узнано на сайте',
    })
  })

  it('FR-ACC-1: a wrong IP is shown even when the session is not alive, and refused events are shown too', async () => {
    await t.close()
    const health: { current: TestHealth } = {
      current: {
        alive: false,
        balance_rub: null,
        presence: false,
        egress_ip: '10.0.0.5',
        egress_ok: false,
      },
    }
    t = await buildTestApp(db, {}, health)
    await t.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'длинныйпароль1' },
    })
    const read = async () =>
      (
        (
          await t.app.inject({ method: 'GET', url: '/api/health', headers: { cookie: t.cookie() } })
        ).json() as {
          checks: { id: string; ok: boolean; detail: string }[]
        }
      ).checks.find((c) => c.id === 'profi')
    expect(await read()).toMatchObject({
      ok: false,
      detail: 'Вкладка выходит в сеть с чужого IP 10.0.0.5',
    })
    health.current = {
      alive: true,
      balance_rub: 1,
      presence: true,
      egress_ip: '127.0.0.1',
      egress_ok: true,
      dead_events: 2,
    }
    expect(await read()).toMatchObject({
      ok: false,
      detail: 'Ядро отказалось принять 2 событий Профи-MCP',
    })
  })
})
