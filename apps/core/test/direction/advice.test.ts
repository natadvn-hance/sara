import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { calibrationItem, directionRun } from '../../src/db/schema'
import { adviseRules, applyAdvice, recalibrate } from '../../src/direction/advice'
import { calibrationResult, setNote } from '../../src/direction/calibration'
import { getOnboarding, startOnboarding } from '../../src/direction/onboarding'
import { getRun, runWorker } from '../../src/direction/runs'
import { seedDirection } from '../../src/direction/store'
import { RULES_V1 } from '../../src/direction/v1'
import { withoutLimitWait } from '../../src/gateway/gateway'
import { calibrate } from '../helpers/calibration'
import { openTestDb, resetDb } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'
import { scorerAnswer } from '../helpers/scorer'

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
const ONE_CHANGE = {
  summary: 'Порог ниже: 50 вместо 56',
  why: 'Ты брал заявки, которые Сара отсеяла',
  rules: { ...RULES_V1, threshold: 50 },
}
const TWO_CHANGES = {
  ...ONE_CHANGE,
  rules: { ...RULES_V1, threshold: 50, about: 'Другое описание' },
}
/** A calibration of the active rules with one lost lead: Boris would take it, Sara dropped it. */
const withMiss = () => calibrate(db, ACC, [...yes(1), ...yes(19)], [30, ...same(19, 70)])

describe('calibration advice', { timeout: 120000 }, () => {
  it('FR-ACC-4: an advice is one change with its lines, and stays on the run', async () => {
    const { runId } = await withMiss()
    const f = await fakeGateway(db, { 'rules-proposer': ONE_CHANGE })
    const r = await adviseRules({ db, gateway: f.gateway }, ACC, runId)
    expect(r).toMatchObject({
      ok: true,
      advice: { summary: ONE_CHANGE.summary, lines: ['Порог: 56 → 50'] },
    })
    expect((await getRun(db, runId))?.advice).toMatchObject({ summary: ONE_CHANGE.summary })
  })

  it('FR-ACC-4: an advice with two changes is thrown away and nothing is kept', async () => {
    const { runId } = await withMiss()
    const f = await fakeGateway(db, { 'rules-proposer': TWO_CHANGES })
    expect(await adviseRules({ db, gateway: f.gateway }, ACC, runId)).toEqual({
      ok: false,
      reason: 'not_one_change',
    })
    expect((await getRun(db, runId))?.advice).toBeNull()
  })

  it('FR-ACC-4: rules that break the contract are an invalid advice', async () => {
    const { runId } = await withMiss()
    const broken = {
      ...ONE_CHANGE,
      rules: { ...RULES_V1, axes: RULES_V1.axes.map((a) => ({ ...a, weight: 1 })) },
    }
    const f = await fakeGateway(db, { 'rules-proposer': broken })
    expect(await adviseRules({ db, gateway: f.gateway }, ACC, runId)).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it("FR-ACC-4: the proposer gets the misses with Boris's words and without the client's name", async () => {
    const { runId, ids } = await withMiss()
    const lost = (await calibrationResult(db, runId)).misses[0]?.leadId ?? ids[0] ?? ''
    await setNote(db, runId, lost, 'копеечный бюджет, не наш клиент')
    const f = await fakeGateway(db, { 'rules-proposer': ONE_CHANGE })
    await adviseRules({ db, gateway: f.gateway }, ACC, runId)
    const [call] = await f.calls()
    expect(call?.role).toBe('rules-proposer')
    expect(call?.stdin).toContain('копеечный бюджет, не наш клиент')
    expect(call?.stdin).toContain('Балл Сары: 30')
    expect(call?.stdin).not.toContain('Андрей')
  })

  it('FR-ACC-4: no misses is no advice and no model call', async () => {
    const { runId } = await calibrate(db, ACC, yes(20), same(20, 70))
    const f = await fakeGateway(db, { 'rules-proposer': ONE_CHANGE })
    expect(await adviseRules({ db, gateway: f.gateway }, ACC, runId)).toEqual({
      ok: false,
      reason: 'no_misses',
    })
    expect(await f.calls()).toHaveLength(0)
  })

  it('FR-ACC-4: a model failure and the Claude limit are told apart', async () => {
    const { runId } = await withMiss()
    const down = await fakeGateway(
      db,
      { 'rules-proposer': ONE_CHANGE },
      { FAKE_CLAUDE_MODE: 'exit1' },
    )
    expect(await adviseRules({ db, gateway: down.gateway }, ACC, runId)).toEqual({
      ok: false,
      reason: 'no_answer',
    })
    const limited = await fakeGateway(
      db,
      { 'rules-proposer': ONE_CHANGE },
      { FAKE_CLAUDE_MODE: 'limit' },
    )
    expect(
      await adviseRules({ db, gateway: withoutLimitWait(limited.gateway) }, ACC, runId),
    ).toEqual({ ok: false, reason: 'limit' })
  })
})

describe('applying an advice', { timeout: 120000 }, () => {
  async function advised() {
    const made = await withMiss()
    const f = await fakeGateway(db, { 'rules-proposer': ONE_CHANGE })
    await adviseRules({ db, gateway: f.gateway }, ACC, made.runId)
    return made
  }

  it('FR-ACC-4: applying an advice changes the draft, makes no version and starts a new run on the same marked sample', async () => {
    const { runId } = await advised()
    const marks = await db.select().from(calibrationItem).where(eq(calibrationItem.runId, runId))
    const r = await applyAdvice(db, ACC, runId, 'advice')
    if (!r.ok) throw new Error(r.error)
    // The draft holds the new threshold, and no version was made.
    expect((await getOnboarding(db, ACC))?.rules?.threshold).toBe(50)
    const versions = await db.execute(sql`select 1 from core.direction_version`)
    expect(versions.rows).toHaveLength(1)
    // The new run: the same leads and the same marks, to be scored again under the new rules.
    const before = await getRun(db, runId)
    const run = await getRun(db, r.runId)
    expect(run).toMatchObject({ kind: 'calibration', state: 'queued', total: 20 })
    expect(run?.leadIds).toEqual(before?.leadIds)
    expect(run?.rulesHash).not.toBe(before?.rulesHash)
    const copied = await db.select().from(calibrationItem).where(eq(calibrationItem.runId, r.runId))
    expect(copied.map((c) => [c.leadId, c.mark]).sort()).toEqual(
      marks.map((c) => [c.leadId, c.mark]).sort(),
    )
    // Scored under the new rules, it gives the agreement without any new marking.
    const g = await fakeGateway(db, { scorer: scorerAnswer(70) })
    await runWorker({ db, ...g }, r.runId)
    expect((await calibrationResult(db, r.runId)).agreement).toBe(1)
  })

  it('FR-ACC-4: applying with no open onboarding starts one', async () => {
    const { runId } = await advised()
    expect(await getOnboarding(db, ACC)).toBeNull()
    const r = await applyAdvice(db, ACC, runId, 'advice')
    expect(r.ok).toBe(true)
    expect(await getOnboarding(db, ACC)).toMatchObject({ mode: 'edit' })
  })

  it('FR-ACC-4: applying the threshold hint changes only the threshold and starts a new run', async () => {
    const { runId } = await calibrate(
      db,
      ACC,
      [...yes(10), ...no(10)],
      [...same(10, 40), ...same(10, 30)],
    )
    const r = await applyAdvice(db, ACC, runId, 'threshold')
    if (!r.ok) throw new Error(r.error)
    const view = await getOnboarding(db, ACC)
    expect(view?.rules).toEqual({ ...RULES_V1, threshold: 40 })
    expect(view?.changes).toEqual(['Порог: 56 → 40'])
    expect((await getRun(db, r.runId))?.state).toBe('queued')
  })

  it('FR-ACC-4: without an advice or a hint there is nothing to apply', async () => {
    const { runId } = await calibrate(db, ACC, yes(20), same(20, 70))
    expect(await applyAdvice(db, ACC, runId, 'advice')).toEqual({ ok: false, error: 'no_advice' })
    expect(await applyAdvice(db, ACC, runId, 'threshold')).toEqual({ ok: false, error: 'no_hint' })
    expect(await applyAdvice(db, ACC, '00000000-0000-4000-8000-000000000000', 'advice')).toEqual({
      ok: false,
      error: 'no_run',
    })
  })

  it('FR-ACC-4: another check going on makes applying wait, and the draft is left as it was', async () => {
    const { runId } = await advised()
    await db.insert(directionRun).values({
      id: '11111111-1111-4111-8111-111111111111',
      accountId: ACC,
      kind: 'recompute',
      rules: RULES_V1,
      rulesHash: 'x',
      leadIds: [],
      total: 0,
      state: 'running',
    })
    expect(await applyAdvice(db, ACC, runId, 'advice')).toEqual({ ok: false, error: 'busy' })
    expect(await getOnboarding(db, ACC)).toBeNull()
  })

  it('FR-ACC-4: a calibration of rules that changed since is repeated on the same sample with the current rules', async () => {
    const { runId } = await withMiss()
    await startOnboarding(db, ACC, 'edit')
    const r = await recalibrate(db, ACC, runId)
    if (!r.ok) throw new Error(r.error)
    const run = await getRun(db, r.runId)
    expect(run?.leadIds).toEqual((await getRun(db, runId))?.leadIds)
    expect(run?.state).toBe('queued')
  })
})
