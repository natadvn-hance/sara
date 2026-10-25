import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedAccounts } from '../../src/accounts/accounts'
import { event, lead } from '../../src/db/schema'
import { getProfile, seedProfile } from '../../src/direction/profile'
import { seedDirection } from '../../src/direction/store'
import { buildTestApp, type TestApp } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'
import { leadWithScore } from '../helpers/learning'
import { CASE, CASES_ANSWER, FORMAT_ANSWER } from '../helpers/onboarding'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
let t: TestApp

async function boot() {
  t = await buildTestApp(db, {
    FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
      'onboarding-format': FORMAT_ANSWER,
      'onboarding-cases': CASES_ANSWER,
    }),
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
  for (const [i, name] of ['Андрей', 'Мария', 'Олег'].entries()) {
    const id = `98100${i}`
    await leadWithScore(db, id, 70)
    await db
      .update(lead)
      .set({ clientName: name, title: `Заказ ${i}` })
      .where(eq(lead.id, id))
  }
  await boot()
})
afterEach(() => t.close())

const send = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  t.app.inject({ method, url, payload: payload as object, headers: { cookie: t.cookie() } })
const on = `/api/directions/${ACC}/onboarding`

describe('the profile steps over HTTP', { timeout: 60000 }, () => {
  it('FR-ACC-3: step 5 is read, edited samples are confirmed, the name in a sample is refused', async () => {
    await send('POST', on, { mode: 'edit' })
    const read = await send('POST', `${on}/steps/5`, { say: 'две части' })
    expect(read.statusCode).toBe(200)
    const samples = read.json().onboarding.steps['5'].proposal.data.samples as {
      lead_id: string
      greeting: string
    }[]
    expect(samples).toHaveLength(3)
    const first = samples[0]
    const name = first?.greeting.split(',')[0] ?? ''
    const named = await send('POST', `${on}/steps/5/confirm`, {
      samples: [{ lead_id: first?.lead_id, body: `Понимаю вас, ${name}, и готова помочь.` }],
    })
    expect(named.statusCode).toBe(422)
    expect(named.json().code).toBe('has_name')
    const unknown = await send('POST', `${on}/steps/5/confirm`, {
      samples: [{ lead_id: 'nope', body: 'текст' }],
    })
    expect(unknown.statusCode).toBe(422)
    const ok = await send('POST', `${on}/steps/5/confirm`, {})
    expect(ok.statusCode).toBe(200)
    expect(ok.json().onboarding.profileChanges).toEqual(['Формат отклика изменён'])
  })

  it('FR-ACC-3: step 5 without any lead says there is nothing to write samples on', async () => {
    await resetDb(db)
    await seedAccounts(db, [{ id: ACC, title: 'Hance маркетинг', egressIp: '127.0.0.1' }])
    await seedDirection(db, ACC)
    await seedProfile(db, ACC)
    await send('POST', on, { mode: 'edit' })
    const r = await send('POST', `${on}/steps/5`, { say: 'формат' })
    expect(r.statusCode).toBe(409)
    expect(r.json().reason).toBe('no_leads')
  })

  it('FR-ACC-3: step 7 takes the speed and rejects anything else', async () => {
    await send('POST', on, { mode: 'edit' })
    expect((await send('POST', `${on}/steps/7/confirm`, { speed: 'turbo' })).statusCode).toBe(400)
    const r = await send('POST', `${on}/steps/7/confirm`, { speed: 'fast' })
    expect(r.statusCode).toBe(200)
    expect(r.json().onboarding.steps['7'].confirmed).toEqual({ speed: 'fast' })
    expect(r.json().onboarding.contradictions.map((c: { id: string }) => c.id)).toEqual([
      'fast_without_bids',
    ])
    expect((await send('POST', `${on}/steps/7`, { say: 'быстро' })).statusCode).toBe(400)
  })

  it('FR-ACC-3: steps 5-7 can be skipped in a new direction too, steps 1-3 cannot', async () => {
    await send('POST', on, { mode: 'new' })
    expect((await send('POST', `${on}/steps/1/skip`)).statusCode).toBe(409)
    expect((await send('POST', `${on}/steps/6/skip`)).statusCode).toBe(200)
  })
})

describe('the profile outside the onboarding', { timeout: 60000 }, () => {
  it('FR-ACC-2: the profile is edited in place, checked, versioned and journaled without its texts', async () => {
    const r = await send('PUT', `/api/directions/${ACC}/profile`, {
      speed: 'fast',
      cases: [CASE],
      reply_format: FORMAT_ANSWER.reply_format,
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().profile).toMatchObject({ speed: 'fast', version: 1 })
    const p = await getProfile(db, ACC)
    expect(p.cases).toEqual([CASE])
    const journal = JSON.stringify(
      await db.select().from(event).where(eq(event.type, 'direction.profile_changed')),
    )
    expect(journal).toContain('"changed"')
    expect(journal).not.toContain(CASE.title)
    expect(journal).not.toContain('Понимаю, для вас')
  })

  it('FR-ACC-2: a bad profile is refused and changes nothing, and so is a state change here', async () => {
    const bad = await send('PUT', `/api/directions/${ACC}/profile`, {
      cases: [{ ...CASE, url: 'http://hance.example/x' }],
    })
    expect(bad.statusCode).toBe(400)
    expect((await getProfile(db, ACC)).cases).toEqual([])
    // Turning a direction on goes through the onboarding gate, never through this door.
    const state = await send('PUT', `/api/directions/${ACC}/profile`, { state: 'on' })
    expect(state.statusCode).toBe(400)
    expect((await send('PUT', `/api/directions/nope/profile`, { speed: 'fast' })).statusCode).toBe(
      404,
    )
  })
})
