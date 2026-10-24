import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedAccounts } from '../../src/accounts/accounts'
import { lead } from '../../src/db/schema'
import { seedProfile } from '../../src/direction/profile'
import { seedDirection } from '../../src/direction/store'
import { buildTestApp, type TestApp } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'
import { leadWithScore } from '../helpers/learning'
import { ABOUT, IDEAL, STOPS } from '../helpers/onboarding'
import { scorerAnswer } from '../helpers/scorer'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
let t: TestApp
/** Scores under IDEAL's two axes, which the old five-axis rules cannot take. */
/** Per lead the old rules are scored first, then the draft, so the model answers in that order. */
const perLead = (leads: number, before: unknown, after: unknown) =>
  Array.from({ length: leads }, () => [before, after]).flat()
const newRulesAnswer = (v: number) => ({
  stop_factor: null,
  red_flags: [],
  axes: IDEAL.axes.map((a) => ({ id: a.id, score: v, why: 'так' })),
  reason: 'Понятная задача',
  confidence: 0.9,
})

async function boot(scorer: unknown[], env: Record<string, string> = {}) {
  t = await buildTestApp(db, {
    FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
      'onboarding-about': ABOUT,
      'onboarding-stops': STOPS,
      'onboarding-ideal': IDEAL,
      scorer: { $sequence: scorer },
    }),
    FAKE_CLAUDE_COUNTER_FILE: join(await mkdtemp(join(tmpdir(), 'runs-')), 'counter.json'),
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
const post = (url: string, payload: unknown) =>
  t.app.inject({ method: 'POST', url, payload: payload as object, headers: { cookie: t.cookie() } })
const runsUrl = `/api/directions/${ACC}/runs`

async function leads(n: number) {
  for (let i = 1; i <= n; i++) {
    const id = String(970000 + i)
    await leadWithScore(db, id, 70)
    await db
      .update(lead)
      .set({ seenAt: new Date(Date.now() - i * 60_000).toISOString() })
      .where(sql`id = ${id}`)
  }
}
/** An onboarding draft whose step 3 is confirmed, so «draft» rules exist. */
async function draftWithIdeal() {
  await post(`/api/directions/${ACC}/onboarding`, { mode: 'edit' })
  await post(`/api/directions/${ACC}/onboarding/steps/1/skip`, {})
  await post(`/api/directions/${ACC}/onboarding/steps/2/skip`, {})
  await post(`/api/directions/${ACC}/onboarding/steps/3`, { say: 'лучшие заказы' })
  await post(`/api/directions/${ACC}/onboarding/steps/3/confirm`, {})
}
async function finished(id: string) {
  const end = Date.now() + 20000
  for (;;) {
    const r = (await get(`${runsUrl}/${id}`)).json()
    if (['done', 'stopped', 'failed'].includes(r.state)) return r
    if (Date.now() > end) throw new Error('the run did not finish')
    await new Promise((res) => setTimeout(res, 100))
  }
}

describe('recompute over HTTP', { timeout: 60000 }, () => {
  it('FR-ACC-5: starting a recompute returns at once and the run finishes in the background', async () => {
    // Per lead: the active rules first, then the draft: all three leads change from show to drop.
    await boot(perLead(3, scorerAnswer(70), newRulesAnswer(40)))
    await leads(3)
    await draftWithIdeal()
    const started = await post(runsUrl, { kind: 'recompute', rules: 'draft' })
    expect(started.statusCode).toBe(202)
    const id = started.json().id as string
    const r = await finished(id)
    expect(r).toMatchObject({ kind: 'recompute', state: 'done', total: 3, done: 3, skipped: 0 })
    expect(r.result).toMatchObject({ checked: 3, changed: 3, toDrop: 3, toShow: 0 })
    expect(r.result.items[0]).toMatchObject({
      before: { score: 70, decision: 'show' },
      after: { score: 40, decision: 'drop' },
    })
  })

  it('FR-ACC-5: the result is only given when the run is done', async () => {
    await boot(perLead(2, scorerAnswer(70), newRulesAnswer(40)), {
      FAKE_CLAUDE_MODE: 'sleep',
      FAKE_CLAUDE_SLEEP_MS: '400',
    })
    await leads(2)
    await draftWithIdeal()
    const { id } = (await post(runsUrl, { kind: 'recompute', rules: 'draft' })).json()
    const early = (await get(`${runsUrl}/${id}`)).json()
    expect(early.state).not.toBe('done')
    expect(early.result).toBeNull()
    expect((await finished(id)).result).not.toBeNull()
  })

  it('FR-ACC-5: a second run while one is going is a 409 with a plain text', async () => {
    await boot(perLead(2, scorerAnswer(70), newRulesAnswer(40)), {
      FAKE_CLAUDE_MODE: 'sleep',
      FAKE_CLAUDE_SLEEP_MS: '400',
    })
    await leads(2)
    await draftWithIdeal()
    const first = await post(runsUrl, { kind: 'recompute', rules: 'draft' })
    const second = await post(runsUrl, { kind: 'recompute', rules: 'draft' })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ error: 'Идёт другая проверка, подожди.' })
    await finished(first.json().id)
  })

  it('FR-ACC-5: no leads is a 409 that says what to turn on', async () => {
    await boot([scorerAnswer(70)])
    await draftWithIdeal()
    const r = await post(runsUrl, { kind: 'recompute', rules: 'draft' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toContain('Заявок для проверки пока нет')
  })

  it('FR-ACC-5: draft rules need a draft; an old version can be tried and an unknown one cannot', async () => {
    await boot([scorerAnswer(70)])
    await leads(1)
    const noDraft = await post(runsUrl, { kind: 'recompute', rules: 'draft' })
    expect(noDraft.statusCode).toBe(409)
    expect(noDraft.json().error).toContain('Черновика правил пока нет')
    expect((await post(runsUrl, { kind: 'recompute', rules: { version: 9 } })).statusCode).toBe(404)
    const old = await post(runsUrl, { kind: 'recompute', rules: { version: 1 } })
    expect(old.statusCode).toBe(202)
    await finished(old.json().id)
  })

  it('FR-ACC-5: the run routes need a session, a known account and a valid body', async () => {
    await boot([scorerAnswer(70)])
    const bare = await t.app.inject({
      method: 'POST',
      url: runsUrl,
      payload: { kind: 'recompute', rules: 'active' },
    })
    expect(bare.statusCode).toBe(401)
    expect(
      (await post('/api/directions/nobody/runs', { kind: 'recompute', rules: 'active' }))
        .statusCode,
    ).toBe(404)
    expect((await post(runsUrl, { kind: 'dance', rules: 'active' })).statusCode).toBe(400)
    expect((await get(`${runsUrl}/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404)
    expect((await get(`${runsUrl}/not-an-id`)).statusCode).toBe(404)
  })

  it('FR-ACC-5: a run of another account is not shown under this one', async () => {
    await boot([scorerAnswer(70)])
    await leads(1)
    const { id } = (await post(runsUrl, { kind: 'recompute', rules: { version: 1 } })).json()
    await finished(id)
    await db.execute(sql`update core.direction_run set account_id = 'hance-it' where id = ${id}`)
    expect((await get(`${runsUrl}/${id}`)).statusCode).toBe(404)
  })
})
