import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedAccounts } from '../../src/accounts/accounts'
import { seedProfile } from '../../src/direction/profile'
import { activeRules, addVersion, seedDirection } from '../../src/direction/store'
import { RULES_V1 } from '../../src/direction/v1'
import { buildTestApp, type TestApp } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'
import { ABOUT, IDEAL, STOPS } from '../helpers/onboarding'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
let t: TestApp
const ANSWERS = { 'onboarding-about': ABOUT, 'onboarding-stops': STOPS, 'onboarding-ideal': IDEAL }
/** The core's HTTP server over the fake Claude, answering the onboarding roles as `answers` say. */
async function boot(env: Record<string, string> = {}) {
  t = await buildTestApp(db, {
    FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify(ANSWERS),
    FAKE_CLAUDE_COUNTER_FILE: join(await mkdtemp(join(tmpdir(), 'routes-')), 'counter.json'),
    ...env,
  })
  await t.secrets.set('claude_oauth_token', 'tok')
  const payload = { password: 'длинныйпароль1' }
  const first = await t.app.inject({ method: 'POST', url: '/api/setup/password', payload })
  // A second boot in the same test finds the password already set.
  if (first.statusCode === 409) await t.app.inject({ method: 'POST', url: '/api/login', payload })
}
beforeEach(async () => {
  await resetDb(db)
  await seedAccounts(db, [{ id: ACC, title: 'Hance маркетинг', egressIp: '127.0.0.1' }])
  await seedDirection(db, ACC)
  await seedProfile(db, ACC)
  await boot()
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

  describe('onboarding', { timeout: 30000 }, () => {
    const say = (step: number, body: object) =>
      post(`/api/directions/${ACC}/onboarding/steps/${step}`, body)

    it('FR-ACC-3: the onboarding goes over HTTP: start, say, confirm, finish', async () => {
      expect((await get(`/api/directions/${ACC}/onboarding`)).json()).toEqual({ onboarding: null })
      const started = await post(`/api/directions/${ACC}/onboarding`, { mode: 'edit' })
      expect(started.statusCode).toBe(200)
      expect(started.json().onboarding).toMatchObject({ mode: 'edit', step: 1 })
      expect((await get(`/api/directions/${ACC}`)).json().onboarding).toEqual({
        open: true,
        step: 1,
      })
      for (const n of [1, 2, 3]) {
        const r = await say(n, { say: `слова ${n}` })
        expect(r.statusCode).toBe(200)
        expect(r.json().onboarding.steps[String(n)].proposal.understood).toBeTruthy()
        const c = await post(`/api/directions/${ACC}/onboarding/steps/${n}/confirm`, {})
        expect(c.statusCode).toBe(200)
      }
      const view = (await get(`/api/directions/${ACC}/onboarding`)).json().onboarding
      expect(view.step).toBe(4)
      expect(view.rules.threshold).toBe(55)
      const refused = await post(`/api/directions/${ACC}/onboarding/finish`, {})
      expect(refused.statusCode).toBe(409)
      expect(refused.json()).toMatchObject({ code: 'needs_calibration' })
      const done = await post(`/api/directions/${ACC}/onboarding/finish`, {
        override: { reason: 'проверю позже' },
      })
      expect(done.json()).toEqual({ version: 2 })
      expect((await activeRules(db, ACC)).rules.threshold).toBe(55)
      expect((await get(`/api/directions/${ACC}`)).json().onboarding).toBeNull()
    })

    it('FR-ACC-3: a step Claude could not read is an error text over HTTP and the draft stays', async () => {
      await t.close()
      await boot({ FAKE_CLAUDE_MODE: 'exit1' })
      await post(`/api/directions/${ACC}/onboarding`, { mode: 'edit' })
      const r = await say(1, { say: 'слова' })
      expect(r.statusCode).toBe(502)
      expect(r.json()).toEqual({
        error: 'Claude не ответил. Попробуй ещё раз.',
        reason: 'no_answer',
      })
      const view = (await get(`/api/directions/${ACC}/onboarding`)).json().onboarding
      expect(view.steps['1']).toBeUndefined()
    })

    it('FR-ACC-3: finishing over newer rules is a 409 stale and rebasing lets it through', async () => {
      await post(`/api/directions/${ACC}/onboarding`, { mode: 'edit' })
      await post(`/api/directions/${ACC}/onboarding/steps/1/skip`, {})
      await post(`/api/directions/${ACC}/onboarding/steps/2/skip`, {})
      await say(3, { say: 'слова' })
      await post(`/api/directions/${ACC}/onboarding/steps/3/confirm`, {})
      await addVersion(db, {
        accountId: ACC,
        rules: { ...RULES_V1, threshold: 40 },
        createdBy: 'boris',
        reason: 'поправка',
      })
      const stale = await post(`/api/directions/${ACC}/onboarding/finish`, {
        override: { reason: 'да' },
      })
      expect(stale.statusCode).toBe(409)
      expect(stale.json()).toMatchObject({ code: 'stale' })
      expect((await post(`/api/directions/${ACC}/onboarding/rebase`, {})).statusCode).toBe(200)
      const done = await post(`/api/directions/${ACC}/onboarding/finish`, {
        override: { reason: 'да' },
      })
      expect(done.json()).toEqual({ version: 3 })
    })

    it('FR-ACC-3: a step that cannot be skipped and a wrong step number are refused', async () => {
      await post(`/api/directions/${ACC}/onboarding`, { mode: 'new' })
      expect((await post(`/api/directions/${ACC}/onboarding/steps/1/skip`, {})).statusCode).toBe(
        409,
      )
      expect((await say(9, { say: 'x' })).statusCode).toBe(400)
      expect((await post(`/api/directions/${ACC}/onboarding/steps/2/confirm`, {})).statusCode).toBe(
        409,
      )
    })

    it('FR-ACC-3: cancelling closes the draft', async () => {
      await post(`/api/directions/${ACC}/onboarding`, { mode: 'edit' })
      expect((await post(`/api/directions/${ACC}/onboarding/cancel`, {})).statusCode).toBe(200)
      expect((await get(`/api/directions/${ACC}/onboarding`)).json()).toEqual({ onboarding: null })
    })

    it('FR-ACC-3: the onboarding routes need a session and a known account', async () => {
      const bare = await t.app.inject({
        method: 'POST',
        url: `/api/directions/${ACC}/onboarding`,
        payload: { mode: 'edit' },
      })
      expect(bare.statusCode).toBe(401)
      expect((await post('/api/directions/nobody/onboarding', { mode: 'edit' })).statusCode).toBe(
        404,
      )
      expect((await say(1, { say: 'x' })).statusCode).toBe(409)
    })
  })
})
