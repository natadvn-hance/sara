import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedAccounts } from '../../src/accounts/accounts'
import { seedProfile } from '../../src/direction/profile'
import { activeRules, addVersion, seedDirection } from '../../src/direction/store'
import { RULES_V1 } from '../../src/direction/v1'
import { buildTestApp, type TestApp } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
let t: TestApp
beforeEach(async () => {
  await resetDb(db)
  await seedAccounts(db, [{ id: ACC, title: 'Hance маркетинг', egressIp: '127.0.0.1' }])
  await seedDirection(db, ACC)
  await seedProfile(db, ACC)
  t = await buildTestApp(db)
  await t.app.inject({
    method: 'POST',
    url: '/api/setup/password',
    payload: { password: 'длинныйпароль1' },
  })
})
afterEach(() => t.close())

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: t.cookie() } })
const post = (url: string, payload: unknown) =>
  t.app.inject({ method: 'POST', url, payload: payload as object, headers: { cookie: t.cookie() } })

describe('direction page API', () => {
  it('FR-ACC-2: the direction page data has the active rules, the versions and the profile', async () => {
    await addVersion(db, {
      accountId: ACC,
      rules: { ...RULES_V1, threshold: 50 },
      createdBy: 'boris',
      reason: 'порог ниже',
    })
    const r = await get(`/api/directions/${ACC}`)
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.account).toEqual({ id: ACC, title: 'Hance маркетинг' })
    expect(body.state).toBe('on')
    expect(body.active.version).toBe(2)
    expect(body.active.rules.threshold).toBe(50)
    expect(
      body.versions.map((v: { version: number; active: boolean }) => [v.version, v.active]),
    ).toEqual([
      [1, false],
      [2, true],
    ])
    expect(body.versions[1]).toMatchObject({ createdBy: 'boris', reason: 'порог ниже' })
    expect(body.profile).toMatchObject({ speed: 'normal', reply_format: null, cases: [] })
    expect(body.onboarding).toBeNull()
  })

  it('FR-MIND-3: rollback adds a new version with the old rules and leaves the history', async () => {
    await addVersion(db, {
      accountId: ACC,
      rules: { ...RULES_V1, threshold: 50 },
      createdBy: 'boris',
      reason: 'порог ниже',
    })
    const r = await post(`/api/directions/${ACC}/rollback`, { version: 1 })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ version: 3 })
    const active = await activeRules(db, ACC)
    expect(active.version).toBe(3)
    expect(active.rules.threshold).toBe(56)
    const view = (await get(`/api/directions/${ACC}`)).json()
    expect(view.versions).toHaveLength(3)
    expect(view.versions[2].reason).toBe('откат к v1')
  })

  it('FR-MIND-3: a version that does not exist is a 404 and nothing changes', async () => {
    const r = await post(`/api/directions/${ACC}/rollback`, { version: 9 })
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ error: 'Такой версии нет.' })
    expect((await activeRules(db, ACC)).version).toBe(1)
  })

  it('FR-MIND-3: rolling back to the version that is already active is a 409 and makes no version', async () => {
    const r = await post(`/api/directions/${ACC}/rollback`, { version: 1 })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toEqual({ error: 'Эта версия уже действует.' })
    expect((await activeRules(db, ACC)).version).toBe(1)
  })

  it('FR-MIND-3: rollback needs a session, a known account and a valid body', async () => {
    const bare = await t.app.inject({
      method: 'POST',
      url: `/api/directions/${ACC}/rollback`,
      payload: { version: 1 },
    })
    expect(bare.statusCode).toBe(401)
    expect((await post('/api/directions/nobody/rollback', { version: 1 })).statusCode).toBe(404)
    expect((await post(`/api/directions/${ACC}/rollback`, { version: 'one' })).statusCode).toBe(400)
    expect((await post(`/api/directions/${ACC}/rollback`, { version: -1 })).statusCode).toBe(400)
  })

  it('FR-ACC-2: an unknown account is a 404', async () => {
    const r = await get('/api/directions/nobody')
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ error: 'Такого аккаунта нет.' })
  })

  it('FR-ACC-2: without a session the direction is 401', async () => {
    const r = await t.app.inject({ method: 'GET', url: `/api/directions/${ACC}` })
    expect(r.statusCode).toBe(401)
  })
})
