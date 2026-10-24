import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { directionOnboarding, event } from '../../src/db/schema'
import {
  cancelOnboarding,
  confirmStep,
  finishOnboarding,
  getOnboarding,
  rebaseOnboarding,
  skipStep,
  startOnboarding,
  submitStep,
} from '../../src/direction/onboarding'
import { seedProfile } from '../../src/direction/profile'
import { activeRules, addVersion, seedDirection } from '../../src/direction/store'
import { RULES_V1 } from '../../src/direction/v1'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'
import { fakeGateway } from '../helpers/gateway'
import { ABOUT, IDEAL, SAME_ABOUT, STOPS } from '../helpers/onboarding'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, ACC)
  await seedProfile(db, ACC)
})

const ANSWERS = { 'onboarding-about': ABOUT, 'onboarding-stops': STOPS, 'onboarding-ideal': IDEAL }
const versions = async () =>
  (
    await db.execute(
      sql`select * from core.direction_version where account_id = ${ACC} order by version`,
    )
  ).rows

/** Says a step and confirms what Claude understood. */
async function sayAndConfirm(
  gateway: Awaited<ReturnType<typeof fakeGateway>>['gateway'],
  step: 1 | 2 | 3,
) {
  const r = await submitStep({ db, gateway }, ACC, step, { say: `слова для шага ${step}` })
  expect(r.ok).toBe(true)
  await confirmStep(db, ACC, step)
}

describe('onboarding flow', { timeout: 30000 }, () => {
  it('FR-ACC-3: the draft is saved at every step and survives a reload', async () => {
    const { gateway } = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    const r = await submitStep({ db, gateway }, ACC, 1, { say: 'Мы делаем маркетинг' })
    expect(r.ok).toBe(true)
    // «Reload»: a fresh read from the database.
    const afterSay = await getOnboarding(db, ACC)
    expect(afterSay?.steps['1']).toMatchObject({
      say: 'Мы делаем маркетинг',
      proposal: { understood: ABOUT.understood },
      confirmed: null,
    })
    expect(afterSay?.step).toBe(1)
    await confirmStep(db, ACC, 1)
    const afterConfirm = await getOnboarding(db, ACC)
    expect(afterConfirm?.steps['1']?.confirmed).toMatchObject({ about: ABOUT.about })
    expect(afterConfirm?.step).toBe(2)
  })

  it('FR-ACC-3: «Нет, поправить» keeps the earlier attempts', async () => {
    const { gateway, calls } = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    await submitStep({ db, gateway }, ACC, 1, { say: 'маркетинг' })
    await submitStep({ db, gateway }, ACC, 1, { say: 'маркетинг', fix: 'Не малого, а среднего' })
    const v = await getOnboarding(db, ACC)
    expect(v?.steps['1']?.attempts).toEqual([
      { fix: null, understood: ABOUT.understood },
      { fix: 'Не малого, а среднего', understood: ABOUT.understood },
    ])
    const last = (await calls()).at(-1)
    expect(last?.stdin).toContain('Не малого, а среднего')
    expect(last?.stdin).toContain(ABOUT.understood)
  })

  it('FR-ACC-3: finishing makes one new version through addVersion and leaves every old row as it was', async () => {
    const { gateway } = await fakeGateway(db, ANSWERS)
    const before = await versions()
    await startOnboarding(db, ACC, 'edit')
    for (const step of [1, 2, 3] as const) await sayAndConfirm(gateway, step)
    const r = await finishOnboarding(db, ACC, { override: { reason: 'проверю позже' } })
    expect(r).toEqual({ ok: true, version: 2 })
    const after = await versions()
    expect(after).toHaveLength(2)
    const strip = (row: Record<string, unknown>) => ({ ...row, active: undefined })
    expect(strip(after[0] as Record<string, unknown>)).toEqual(
      strip(before[0] as Record<string, unknown>),
    )
    expect(after[1]).toMatchObject({ version: 2, created_by: 'boris', active: true })
    expect(String((after[1] as { reason: string }).reason)).toMatch(/^Онбординг: /)
    const active = await activeRules(db, ACC)
    expect(active.rules.about).toBe(ABOUT.about)
    expect(active.rules.axes.map((a) => a.id)).toEqual(['client', 'task'])
    expect(active.rules.threshold).toBe(55)
    expect(await getOnboarding(db, ACC)).toBeNull()
  })

  it('FR-ACC-3: finishing with rules equal to the active ones makes no version', async () => {
    const { gateway } = await fakeGateway(db, { ...ANSWERS, 'onboarding-about': SAME_ABOUT })
    await startOnboarding(db, ACC, 'edit')
    await sayAndConfirm(gateway, 1)
    await skipStep(db, ACC, 2)
    await skipStep(db, ACC, 3)
    expect(await finishOnboarding(db, ACC, {})).toEqual({ ok: true, version: null })
    expect(await versions()).toHaveLength(1)
  })

  it('FR-ACC-3: edit mode takes the sections Boris did not confirm from the active rules', async () => {
    const { gateway } = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    await skipStep(db, ACC, 1)
    await skipStep(db, ACC, 2)
    await sayAndConfirm(gateway, 3)
    const v = await getOnboarding(db, ACC)
    expect(v?.rules).toMatchObject({
      about: RULES_V1.about,
      stop_factors: RULES_V1.stop_factors,
      red_flags: RULES_V1.red_flags,
      threshold: 55,
    })
    expect(v?.rules?.axes.map((a) => a.id)).toEqual(['client', 'task'])
  })

  it('FR-ACC-3: two finishes at once give one version', async () => {
    const { gateway } = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    for (const step of [1, 2, 3] as const) await sayAndConfirm(gateway, step)
    const o = { override: { reason: 'да' } }
    const results = await Promise.all([finishOnboarding(db, ACC, o), finishOnboarding(db, ACC, o)])
    expect(results.filter((r) => r.ok && r.version !== null)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'closed' }])
    expect(await versions()).toHaveLength(2)
  })

  it('FR-ACC-3: rules changed meanwhile make finishing stale, and rebasing keeps the confirmed steps', async () => {
    const { gateway } = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    await skipStep(db, ACC, 1)
    await skipStep(db, ACC, 2)
    await sayAndConfirm(gateway, 3)
    // A proposal Boris applied from Telegram while he was setting up: a new active version.
    await addVersion(db, {
      accountId: ACC,
      rules: { ...RULES_V1, about: 'Новое описание от предложения поправки' },
      createdBy: 'boris',
      reason: 'поправка',
    })
    expect(await finishOnboarding(db, ACC, { override: { reason: 'да' } })).toEqual({
      ok: false,
      error: 'stale',
    })
    expect(await versions()).toHaveLength(2)
    const view = await rebaseOnboarding(db, ACC)
    expect(view?.steps['3']?.confirmed).toMatchObject({ threshold: 55 })
    expect(await finishOnboarding(db, ACC, { override: { reason: 'да' } })).toEqual({
      ok: true,
      version: 3,
    })
    const active = await activeRules(db, ACC)
    // His confirmed axes, and the other sections from the newest version, not the old one.
    expect(active.rules.about).toBe('Новое описание от предложения поправки')
    expect(active.rules.threshold).toBe(55)
  })

  it('FR-ACC-3: a model miss leaves the draft unchanged', async () => {
    const { gateway } = await fakeGateway(db, ANSWERS, { FAKE_CLAUDE_MODE: 'exit1' })
    await startOnboarding(db, ACC, 'edit')
    const before = await db.select().from(directionOnboarding)
    const r = await submitStep({ db, gateway }, ACC, 2, { say: 'не берём директ' })
    expect(r).toMatchObject({ ok: false, reason: 'no_answer' })
    const after = await db.select().from(directionOnboarding)
    expect(after[0]?.draft).toEqual(before[0]?.draft)
  })

  it('FR-ACC-3: changed rules without a calibration need an override with a reason, and the journal keeps no words', async () => {
    const { gateway } = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    for (const step of [1, 2, 3] as const) await sayAndConfirm(gateway, step)
    expect(await finishOnboarding(db, ACC, {})).toEqual({ ok: false, error: 'needs_calibration' })
    expect(await finishOnboarding(db, ACC, { override: { reason: '  ' } })).toEqual({
      ok: false,
      error: 'needs_calibration',
    })
    expect(await versions()).toHaveLength(1)
    const r = await finishOnboarding(db, ACC, { override: { reason: 'секретное слово Бориса' } })
    expect(r).toEqual({ ok: true, version: 2 })
    const [row] = await db.select().from(directionOnboarding)
    expect(row).toMatchObject({ state: 'finished', overrideReason: 'секретное слово Бориса' })
    const events = await db.select().from(event)
    expect(JSON.stringify(events)).not.toContain('секретное слово Бориса')
    expect(JSON.stringify(events)).not.toContain('слова для шага')
    const finished = events.find((e) => e.type === 'direction.onboarding_finished')
    expect(finished?.payload).toMatchObject({ version: 2, override: true })
  })

  it('FR-ACC-3: a new direction cannot finish before steps 1-3 and cannot skip them', async () => {
    const { gateway } = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'new')
    expect(await skipStep(db, ACC, 1)).toBeNull()
    await sayAndConfirm(gateway, 1)
    expect(await finishOnboarding(db, ACC, { override: { reason: 'да' } })).toEqual({
      ok: false,
      error: 'incomplete',
    })
    await sayAndConfirm(gateway, 2)
    await sayAndConfirm(gateway, 3)
    const r = await finishOnboarding(db, ACC, { override: { reason: 'да' } })
    expect(r).toEqual({ ok: true, version: 2 })
    // New mode builds from nothing: the old stop factors are gone.
    expect((await activeRules(db, ACC)).rules.stop_factors.map((s) => s.id)).toEqual(['direct'])
  })

  it('FR-ACC-3: starting twice returns the open draft, and cancelling gives a fresh one next time', async () => {
    const { gateway } = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    await sayAndConfirm(gateway, 1)
    const again = await startOnboarding(db, ACC, 'edit')
    expect(again.steps['1']?.confirmed).not.toBeNull()
    await cancelOnboarding(db, ACC)
    expect(await getOnboarding(db, ACC)).toBeNull()
    const fresh = await startOnboarding(db, ACC, 'edit')
    expect(fresh.steps['1']).toBeUndefined()
  })

  it('FR-ACC-3: the journal keeps the step number and no words', async () => {
    const { gateway } = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    await sayAndConfirm(gateway, 1)
    expect(await countEvents(db, 'direction.onboarding_started')).toBe(1)
    const [e] = await db.select().from(event).where(eq(event.type, 'direction.step_confirmed'))
    expect(e?.payload).toEqual({ step: 1 })
  })

  it('FR-ACC-3: a step outside 1-3 and a step without an onboarding are refused', async () => {
    const { gateway } = await fakeGateway(db, ANSWERS)
    expect(await submitStep({ db, gateway }, ACC, 1, { say: 'x' })).toMatchObject({
      ok: false,
      reason: 'no_onboarding',
    })
    await startOnboarding(db, ACC, 'edit')
    expect(await submitStep({ db, gateway }, ACC, 5, { say: 'x' })).toMatchObject({
      ok: false,
      reason: 'bad_step',
    })
    expect(await confirmStep(db, ACC, 1)).toBeNull()
  })
})
