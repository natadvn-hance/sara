import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { directionOverride, event } from '../../src/db/schema'
import { calibrationView, markItem, startCalibration } from '../../src/direction/calibration'
import {
  confirmStep,
  finishOnboarding,
  skipStep,
  startOnboarding,
  submitStep,
} from '../../src/direction/onboarding'
import { getProfile, seedProfile } from '../../src/direction/profile'
import { activeRules, seedDirection } from '../../src/direction/store'
import { RULES_V1 } from '../../src/direction/v1'
import { calibrate, leadsWith } from '../helpers/calibration'
import { openTestDb, resetDb } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'
import { IDEAL } from '../helpers/onboarding'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, ACC)
})

const yes = (n: number) => Array.from({ length: n }, () => 'yes' as const)
const no = (n: number) => Array.from({ length: n }, () => 'no' as const)
const same = (n: number, v: number) => Array.from({ length: n }, () => v)
/** What the model says for step 3: the same axes, another threshold, so one thing changes. */
const ideal = (threshold: number) => ({
  ...IDEAL,
  axes: RULES_V1.axes,
  threshold,
  notes: RULES_V1.notes,
})
const rulesWith = (threshold: number) => ({ ...RULES_V1, threshold })

/** A draft of `accountId` whose only change is the threshold, built through the steps. */
async function draftWith(threshold: number, accountId = ACC) {
  const f = await fakeGateway(db, { 'onboarding-ideal': ideal(threshold) })
  await startOnboarding(db, accountId, 'edit')
  await skipStep(db, accountId, 1)
  await skipStep(db, accountId, 2)
  await submitStep({ db, gateway: f.gateway }, accountId, 3, { say: 'порог' })
  await confirmStep(db, accountId, 3)
}

describe('the 85% gate of finishing', { timeout: 120000 }, () => {
  it('FR-ACC-4: finishing changed rules needs a passed calibration on exactly those rules', async () => {
    await draftWith(50)
    expect(await finishOnboarding(db, ACC, {})).toEqual({ ok: false, error: 'needs_calibration' })
    await calibrate(db, ACC, [...yes(17), ...no(3)], same(20, 70), rulesWith(50))
    expect(await finishOnboarding(db, ACC, {})).toEqual({ ok: true, version: 2 })
    expect((await activeRules(db, ACC)).rules.threshold).toBe(50)
    // No override was used, so nothing of the sort is kept or journaled.
    expect(await db.select().from(directionOverride)).toEqual([])
    const [e] = await db.select().from(event).where(eq(event.type, 'direction.onboarding_finished'))
    expect(e?.payload).not.toHaveProperty('override')
  })

  it('FR-ACC-4: the same rules with another threshold need a new calibration', async () => {
    await calibrate(db, ACC, [...yes(17), ...no(3)], same(20, 70), rulesWith(50))
    await draftWith(45)
    expect(await finishOnboarding(db, ACC, {})).toEqual({ ok: false, error: 'needs_calibration' })
  })

  it('FR-ACC-4: 80% does not open the gate, only an override with a reason saves', async () => {
    await draftWith(50)
    await calibrate(db, ACC, [...yes(16), ...no(4)], same(20, 70), rulesWith(50))
    expect(await finishOnboarding(db, ACC, {})).toEqual({ ok: false, error: 'needs_calibration' })
    expect(await finishOnboarding(db, ACC, { override: { reason: 'потом проверю' } })).toEqual({
      ok: true,
      version: 2,
    })
    expect(await db.select().from(directionOverride)).toMatchObject([
      { accountId: ACC, version: 2, reason: 'потом проверю' },
    ])
  })

  it('FR-ACC-4: a calibration that is still being scored does not open the gate', async () => {
    await draftWith(50)
    await leadsWith(
      db,
      Array.from({ length: 20 }, () => 60),
    )
    const r = await startCalibration(db, { accountId: ACC, rules: rulesWith(50) })
    if (!r.ok) throw new Error('no run')
    for (const i of (await calibrationView(db, r.runId)).items)
      await markItem(db, r.runId, i.leadId, 'yes')
    expect(await finishOnboarding(db, ACC, {})).toEqual({ ok: false, error: 'needs_calibration' })
  })

  it('FR-ACC-4: a calibration of another account does not open the gate', async () => {
    await seedDirection(db, 'hance-it')
    await draftWith(50)
    await calibrate(db, 'hance-it', [...yes(17), ...no(3)], same(20, 70), rulesWith(50))
    expect(await finishOnboarding(db, ACC, {})).toEqual({ ok: false, error: 'needs_calibration' })
  })
})

describe('turning a direction on while finishing', { timeout: 120000 }, () => {
  const IT = 'hance-it'
  beforeEach(async () => {
    await seedDirection(db, IT)
    await seedProfile(db, IT)
  })

  it('FR-ACC-4: «Включить в тени» sets the profile to shadow in the same transaction as the version', async () => {
    expect((await getProfile(db, IT)).state).toBe('draft')
    await draftWith(50, IT)
    await calibrate(db, IT, [...yes(17), ...no(3)], same(20, 70), rulesWith(50))
    expect(await finishOnboarding(db, IT, { state: 'shadow' })).toEqual({ ok: true, version: 2 })
    expect(await getProfile(db, IT)).toMatchObject({ state: 'shadow', version: 1 })
  })

  it('FR-ACC-4: a refused finish leaves the profile as it was', async () => {
    await draftWith(50, IT)
    expect(await finishOnboarding(db, IT, { state: 'on' })).toEqual({
      ok: false,
      error: 'needs_calibration',
    })
    expect((await getProfile(db, IT)).state).toBe('draft')
  })

  it('FR-ACC-4: «Включить» with rules that changed nothing still turns the direction on', async () => {
    await startOnboarding(db, IT, 'edit')
    for (const step of [1, 2, 3] as const) await skipStep(db, IT, step)
    expect(await finishOnboarding(db, IT, { state: 'on' })).toEqual({ ok: true, version: null })
    expect((await getProfile(db, IT)).state).toBe('on')
  })
})
