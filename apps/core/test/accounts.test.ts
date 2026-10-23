import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { completeStep } from '../src/setup/progress'
import { buildTestApp, type TestApp, type TestHealth } from './helpers/app'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)

let t: TestApp
const health: { current: TestHealth } = {
  current: { alive: false, balance_rub: null, presence: false, egress_ip: null },
}
beforeEach(async () => {
  await resetDb(db)
  health.current = { alive: false, balance_rub: null, presence: false, egress_ip: null }
  t = await buildTestApp(db, {}, health)
  await t.app.inject({
    method: 'POST',
    url: '/api/setup/password',
    payload: { password: 'длинныйпароль1' },
  })
})
afterEach(() => t.close())

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: t.cookie() } })

describe('accounts', () => {
  it('FR-SET-4: the wizard step completes when the session is alive and the IP matches', async () => {
    expect((await get('/api/setup/profi/status')).json()).toMatchObject({
      alive: false,
      ipOk: false,
    })
    health.current = { alive: true, balance_rub: 5000, presence: true, egress_ip: '203.0.113.9' }
    expect((await get('/api/setup/profi/status')).json()).toMatchObject({
      alive: true,
      ipOk: false,
    })
    expect((await get('/api/setup')).json().completed).not.toContain('profi')
    health.current = { ...health.current, egress_ip: '127.0.0.1' }
    expect((await get('/api/setup/profi/status')).json()).toMatchObject({ alive: true, ipOk: true })
    expect((await get('/api/setup')).json().completed).toContain('profi')
  })

  it('FR-ACC-1: the accounts list shows state, balance and whether the IP is the account own', async () => {
    health.current = { alive: true, balance_rub: 4200, presence: true, egress_ip: '127.0.0.1' }
    expect((await get('/api/accounts')).json()).toEqual({
      accounts: [
        {
          id: 'hance-marketing',
          title: 'Hance маркетинг',
          login_state: 'alive',
          balance_rub: 4200,
          presence: true,
          egress_ip: '127.0.0.1',
          ip_ok: true,
        },
      ],
    })
  })

  it('FR-SET-1: the Profi.ru step can be left for later and the wizard goes on', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/setup/profi/later',
      headers: { cookie: t.cookie() },
    })
    expect(r.statusCode).toBe(200)
    await completeStep(db, 'telegram')
    await completeStep(db, 'claude')
    expect((await get('/api/setup')).json()).toEqual({
      next: 'done',
      completed: ['password', 'telegram', 'claude'],
    })
  })
})
