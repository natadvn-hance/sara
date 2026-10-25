import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedAccounts } from '../../src/accounts/accounts'
import { getProfile, seedProfile } from '../../src/direction/profile'
import { seedDirection } from '../../src/direction/store'
import { RULES_V1 } from '../../src/direction/v1'
import { buildTestApp, type TestApp } from '../helpers/app'
import { leadsWith } from '../helpers/calibration'
import { openTestDb, resetDb } from '../helpers/db'
import { ABOUT, IDEAL, STOPS } from '../helpers/onboarding'
import { scorerAnswer } from '../helpers/scorer'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
let t: TestApp
const ONE_CHANGE = {
  summary: 'Порог ниже: 50 вместо 56',
  why: 'Ты брал заявки, которые Сара отсеяла',
  rules: { ...RULES_V1, threshold: 50 },
}

async function boot(scorer: unknown[], env: Record<string, string> = {}) {
  t = await buildTestApp(db, {
    FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
      'onboarding-about': ABOUT,
      'onboarding-stops': STOPS,
      // Same axes as the active rules and another threshold, so the scorer's answers fit the draft too.
      'onboarding-ideal': { ...IDEAL, axes: RULES_V1.axes, threshold: 50, notes: RULES_V1.notes },
      'rules-proposer': ONE_CHANGE,
      scorer: { $sequence: scorer },
    }),
    FAKE_CLAUDE_COUNTER_FILE: join(await mkdtemp(join(tmpdir(), 'cal-')), 'counter.json'),
    ...env,
  })
  await t.secrets.set('claude_oauth_token', 'tok')
  await t.app.inject({
    method: 'POST',
    url: '/api/setup/password',
    payload: { password: 'длинныйпароль1' },
  })
}
beforeEach(async () => {
  await resetDb(db)
  await seedAccounts(db, [{ id: ACC, title: 'Hance маркетинг', egressIp: '127.0.0.1' }])
  await seedDirection(db, ACC)
  await seedProfile(db, ACC)
})
afterEach(() => t.close())

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: t.cookie() } })
const post = (url: string, payload: unknown = {}) =>
  t.app.inject({ method: 'POST', url, payload: payload as object, headers: { cookie: t.cookie() } })
const runs = `/api/directions/${ACC}/runs`

type Item = { leadId: string; mark: string | null }
const view = async (id: string) => (await get(`${runs}/${id}`)).json()
async function done(id: string) {
  const end = Date.now() + 30000
  for (;;) {
    const r = await view(id)
    if (['done', 'stopped', 'failed'].includes(r.state)) return r
    if (Date.now() > end) throw new Error('the run did not finish')
    await new Promise((res) => setTimeout(res, 100))
  }
}
/** Starts a calibration of the active rules and marks every lead: `marks[i]` for the i-th one. */
async function startAndMark(marks: ('yes' | 'no' | 'unsure')[], rules: unknown = 'active') {
  const started = await post(runs, { kind: 'calibration', rules })
  expect(started.statusCode).toBe(201)
  const id = started.json().id as string
  const items = (await view(id)).calibration.items as Item[]
  let last = { complete: false }
  for (const [i, it] of items.entries()) {
    const r = await post(`${runs}/${id}/marks`, { lead_id: it.leadId, mark: marks[i] ?? 'unsure' })
    last = r.json()
  }
  return { id, items, last }
}
const same = (n: number, v: number) => Array.from({ length: n }, () => scorerAnswer(v))
const yes = (n: number) => Array.from({ length: n }, () => 'yes' as const)

describe('calibration over HTTP', { timeout: 120000 }, () => {
  it('FR-ACC-4: Boris marks the sample, it is scored in the background, and the result comes with the agreement', async () => {
    await boot(same(16, 70))
    await leadsWith(
      db,
      Array.from({ length: 16 }, () => 60),
    )
    const { id, last } = await startAndMark(yes(16))
    expect(last).toMatchObject({ ok: true, marked: 16, total: 16, complete: true })
    const r = await done(id)
    expect(r).toMatchObject({ kind: 'calibration', state: 'done', total: 16 })
    expect(r.calibration.result).toMatchObject({
      decisive: 16,
      agreement: 1,
      passed: true,
      reliable: true,
    })
    expect(r.calibration.stale).toBe(false)
  })

  it('FR-ACC-4: while Boris marks, the screen gets the orders and his marks and nothing of Sara', async () => {
    await boot(same(12, 70))
    await leadsWith(
      db,
      Array.from({ length: 12 }, () => 60),
    )
    const started = (await post(runs, { kind: 'calibration', rules: 'active' })).json()
    expect(started).toMatchObject({ total: 12 })
    const v = await view(started.id)
    expect(v).toMatchObject({ state: 'marking', calibration: { marked: 0 } })
    const text = JSON.stringify(v)
    for (const word of ['score', 'decision', 'axes', '"reason"']) expect(text).not.toContain(word)
    expect(v.result).toBeNull()
  })

  it('FR-ACC-4: no leads and too few leads are told apart in plain words', async () => {
    await boot(same(1, 70))
    const none = await post(runs, { kind: 'calibration', rules: 'active' })
    expect(none.statusCode).toBe(409)
    expect(none.json().error).toContain('Заявок для проверки пока нет')
    await leadsWith(
      db,
      Array.from({ length: 4 }, () => 60),
    )
    const few = await post(runs, { kind: 'calibration', rules: 'active' })
    expect(few.statusCode).toBe(409)
    expect(few.json().error).toBe('Заявок пока мало: 4, нужно хотя бы 10.')
  })

  it('FR-ACC-4: a mark outside the sample, a bad mark and a mark on a finished run are refused', async () => {
    await boot(same(10, 70))
    await leadsWith(
      db,
      Array.from({ length: 10 }, () => 60),
    )
    const { id, items } = await startAndMark(yes(10))
    await done(id)
    expect(
      (await post(`${runs}/${id}/marks`, { lead_id: items[0]?.leadId, mark: 'yes' })).statusCode,
    ).toBe(409)
    expect((await post(`${runs}/${id}/marks`, { lead_id: 'x', mark: 'maybe' })).statusCode).toBe(
      400,
    )
    const again = await post(runs, { kind: 'calibration', rules: 'active' })
    const fresh = again.json().id as string
    expect(
      (await post(`${runs}/${fresh}/marks`, { lead_id: 'nope', mark: 'yes' })).statusCode,
    ).toBe(404)
  })

  it("FR-ACC-4: a lead Sara dropped can get Boris's note, advice comes for the misses and applying it starts a new run", async () => {
    // The first lead of the sample is dropped by Sara (30), the other fifteen shown; Boris says yes to all.
    await boot([scorerAnswer(30), ...same(30, 70)])
    await leadsWith(
      db,
      Array.from({ length: 16 }, () => 60),
    )
    const { id } = await startAndMark(yes(16))
    const finished = await done(id)
    const miss = finished.calibration.result.misses[0]
    expect(miss).toMatchObject({ kind: 'sara_no_boris_yes' })
    expect(
      (await post(`${runs}/${id}/notes`, { lead_id: miss.leadId, note: 'нормальный бюджет' }))
        .statusCode,
    ).toBe(200)
    expect((await view(id)).calibration.result.misses[0].note).toBe('нормальный бюджет')
    const advice = await post(`${runs}/${id}/advice`)
    expect(advice.statusCode).toBe(200)
    expect(advice.json().advice).toMatchObject({
      summary: ONE_CHANGE.summary,
      lines: ['Порог: 56 → 50'],
    })
    expect((await view(id)).calibration.advice).toMatchObject({ summary: ONE_CHANGE.summary })
    const applied = await post(`${runs}/${id}/apply`, { source: 'advice' })
    expect(applied.statusCode).toBe(200)
    const next = await done(applied.json().id)
    expect(next).toMatchObject({ kind: 'calibration', state: 'done' })
    const draft = (await get(`/api/directions/${ACC}/onboarding`)).json().onboarding
    expect(draft.rules.threshold).toBe(50)
    expect((await view(id)).calibration.stale).toBe(true)
    expect(next.calibration.stale).toBe(false)
  })

  it('FR-ACC-4: advice with nothing to fix, and applying what is not there, say so', async () => {
    await boot(same(20, 70))
    await leadsWith(
      db,
      Array.from({ length: 10 }, () => 60),
    )
    const { id } = await startAndMark(yes(10))
    await done(id)
    expect((await post(`${runs}/${id}/advice`)).statusCode).toBe(409)
    expect((await post(`${runs}/${id}/apply`, { source: 'advice' })).statusCode).toBe(409)
    expect((await post(`${runs}/${id}/apply`, { source: 'threshold' })).statusCode).toBe(409)
    expect((await post(`${runs}/${id}/apply`, { source: 'other' })).statusCode).toBe(400)
  })

  it('FR-ACC-4: a calibration of rules that changed since is shown as stale and can be repeated without marking', async () => {
    await boot(same(40, 70))
    await leadsWith(
      db,
      Array.from({ length: 10 }, () => 60),
    )
    const { id } = await startAndMark(yes(10))
    await done(id)
    await post(`/api/directions/${ACC}/onboarding`, { mode: 'edit' })
    await post(`/api/directions/${ACC}/onboarding/steps/1/skip`, {})
    await post(`/api/directions/${ACC}/onboarding/steps/2/skip`, {})
    await post(`/api/directions/${ACC}/onboarding/steps/3`, { say: 'лучшие заказы' })
    await post(`/api/directions/${ACC}/onboarding/steps/3/confirm`, {})
    expect((await view(id)).calibration.stale).toBe(true)
    const again = await post(`${runs}/${id}/recalibrate`)
    expect(again.statusCode).toBe(200)
    const r = await done(again.json().id)
    expect(r.calibration.stale).toBe(false)
    expect(r.calibration.result.decisive).toBe(10)
  })

  it('FR-ACC-4: finishing over HTTP can turn the direction on in the shadow, after a passed calibration', async () => {
    await boot(same(40, 70))
    await db.execute(sql`update core.direction_profile set state = 'draft'`)
    await leadsWith(
      db,
      Array.from({ length: 16 }, () => 60),
    )
    // A draft with one change, and a calibration of exactly those rules.
    await post(`/api/directions/${ACC}/onboarding`, { mode: 'edit' })
    await post(`/api/directions/${ACC}/onboarding/steps/1/skip`, {})
    await post(`/api/directions/${ACC}/onboarding/steps/2/skip`, {})
    await post(`/api/directions/${ACC}/onboarding/steps/3`, { say: 'лучшие заказы' })
    await post(`/api/directions/${ACC}/onboarding/steps/3/confirm`, {})
    const draft = (await get(`/api/directions/${ACC}/onboarding`)).json().onboarding
    expect(draft.changed).toBe(true)
    const refused = await post(`/api/directions/${ACC}/onboarding/finish`, { state: 'shadow' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'needs_calibration' })
    const { id } = await startAndMark(yes(16), 'draft')
    const r = await done(id)
    expect(r.calibration.result.passed).toBe(true)
    const ok = await post(`/api/directions/${ACC}/onboarding/finish`, { state: 'shadow' })
    expect(ok.statusCode).toBe(200)
    expect((await getProfile(db, ACC)).state).toBe('shadow')
  })

  it('FR-ACC-4: the calibration routes need a session, a known account and a valid body', async () => {
    await boot(same(1, 70))
    const bare = await t.app.inject({
      method: 'POST',
      url: runs,
      payload: { kind: 'calibration', rules: 'active' },
    })
    expect(bare.statusCode).toBe(401)
    expect(
      (await post('/api/directions/nobody/runs', { kind: 'calibration', rules: 'active' }))
        .statusCode,
    ).toBe(404)
    const nope = '00000000-0000-4000-8000-000000000000'
    expect((await post(`${runs}/${nope}/marks`, { lead_id: 'x', mark: 'yes' })).statusCode).toBe(
      404,
    )
    expect((await post(`${runs}/${nope}/advice`)).statusCode).toBe(404)
    expect((await post(`${runs}/${nope}/recalibrate`)).statusCode).toBe(404)
  })

  it('FR-ACC-4: advice, apply and a note with a run id that is not an id are a 404, not a crash', async () => {
    await boot(same(1, 70))
    expect((await post(`${runs}/not-an-id/advice`)).statusCode).toBe(404)
    expect((await post(`${runs}/not-an-id/apply`, { source: 'advice' })).statusCode).toBe(404)
    expect((await post(`${runs}/not-an-id/notes`, { lead_id: 'x', note: 'y' })).statusCode).toBe(
      404,
    )
  })

  it('FR-ACC-4: a note for a lead that is not in the run is a 404', async () => {
    await boot(same(10, 70))
    await leadsWith(
      db,
      Array.from({ length: 10 }, () => 60),
    )
    const { id } = await startAndMark(yes(10))
    await done(id)
    const r = await post(`${runs}/${id}/notes`, { lead_id: 'nope', note: 'слова' })
    expect(r.statusCode).toBe(404)
  })

  it('FR-ACC-4: repeating a calibration that still waits for marks is a 409', async () => {
    await boot(same(10, 70))
    await leadsWith(
      db,
      Array.from({ length: 10 }, () => 60),
    )
    const started = (await post(runs, { kind: 'calibration', rules: 'active' })).json()
    const r = await post(`${runs}/${started.id}/recalibrate`)
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('Эта проверка ещё ждёт отметок.')
  })

  it('FR-ACC-4: applying an advice to rules Boris has edited since is a 409 that says to check again', async () => {
    await boot([scorerAnswer(30), ...same(30, 70)])
    await leadsWith(
      db,
      Array.from({ length: 16 }, () => 60),
    )
    const { id } = await startAndMark(yes(16))
    await done(id)
    expect((await post(`${runs}/${id}/advice`)).statusCode).toBe(200)
    await post(`/api/directions/${ACC}/onboarding`, { mode: 'edit' })
    await post(`/api/directions/${ACC}/onboarding/steps/1/skip`, {})
    await post(`/api/directions/${ACC}/onboarding/steps/2/skip`, {})
    await post(`/api/directions/${ACC}/onboarding/steps/3`, { say: 'лучшие заказы' })
    await post(`/api/directions/${ACC}/onboarding/steps/3/confirm`, {})
    const r = await post(`${runs}/${id}/apply`, { source: 'advice' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('Правила изменились после этой проверки: проверь заново.')
  })
})
