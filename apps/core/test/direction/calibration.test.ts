import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lead, leadLabel } from '../../src/db/schema'
import {
  CALIBRATION_TARGET,
  calibrationResult,
  calibrationSample,
  calibrationView,
  markItem,
  startCalibration,
} from '../../src/direction/calibration'
import { getRun } from '../../src/direction/runs'
import { seedDirection } from '../../src/direction/store'
import { RULES_V1 } from '../../src/direction/v1'
import { calibrate, idOf, leadsWith } from '../helpers/calibration'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, ACC)
})

// Around the threshold of 56 the near group is 44..68: 12 near, 9 above, 9 below.
const MIX = [
  ...Array.from({ length: 12 }, (_, i) => 46 + i * 2),
  ...Array.from({ length: 9 }, (_, i) => 75 + i * 2),
  ...Array.from({ length: 9 }, (_, i) => 10 + i * 3),
]
const near = (s: number) => Math.abs(s - 56) <= 12
const scoreOf = (id: string) => MIX[Number(id) - 971000] as number

describe('calibration sample', { timeout: 60000 }, () => {
  it('FR-ACC-4: the sample is 20 leads: 8 near the threshold, 6 clearly above, 6 clearly below', async () => {
    await leadsWith(db, MIX)
    const sample = await calibrationSample(db, ACC, RULES_V1, 1)
    expect(sample).toHaveLength(20)
    expect(new Set(sample).size).toBe(20)
    const scores = sample.map(scoreOf)
    expect(scores.filter(near)).toHaveLength(8)
    expect(scores.filter((s) => s > 68)).toHaveLength(6)
    expect(scores.filter((s) => s < 44)).toHaveLength(6)
  })

  it('FR-ACC-4: leads Boris decided on by card or summary, sorted-out and stale leads, old leads and other accounts are not in it', async () => {
    await leadsWith(
      db,
      Array.from({ length: 30 }, () => 60),
    )
    await db.insert(leadLabel).values([
      { leadId: idOf(0), label: 'yes', source: 'card' },
      { leadId: idOf(1), label: 'no', source: 'summary' },
    ])
    await db
      .update(lead)
      .set({ status: 'sorted_out' })
      .where(eq(lead.id, idOf(2)))
    await db
      .update(lead)
      .set({ status: 'stale' })
      .where(eq(lead.id, idOf(3)))
    await db
      .update(lead)
      .set({ accountId: 'hance-it' })
      .where(eq(lead.id, idOf(4)))
    await db
      .update(lead)
      .set({ seenAt: new Date(Date.now() - 61 * 86_400_000).toISOString() })
      .where(eq(lead.id, idOf(5)))
    const banned = [0, 1, 2, 3, 4, 5].map(idOf)
    for (const seed of [1, 2, 3]) {
      const sample = await calibrationSample(db, ACC, RULES_V1, seed)
      expect(sample).toHaveLength(20)
      expect(sample.some((id) => banned.includes(id))).toBe(false)
    }
  })

  it('FR-ACC-4: a card nobody pressed (a weak no) does not keep a lead out', async () => {
    await leadsWith(
      db,
      Array.from({ length: 20 }, () => 60),
    )
    await db.insert(leadLabel).values(
      Array.from({ length: 20 }, (_, i) => ({
        leadId: idOf(i),
        label: 'weak_no',
        source: 'ignored',
      })),
    )
    expect(await calibrationSample(db, ACC, RULES_V1, 1)).toHaveLength(20)
  })

  it('FR-ACC-4: the same seed gives the same sample, another seed another one', async () => {
    await leadsWith(db, MIX)
    const a = await calibrationSample(db, ACC, RULES_V1, 1)
    expect(await calibrationSample(db, ACC, RULES_V1, 1)).toEqual(a)
    expect(await calibrationSample(db, ACC, RULES_V1, 2)).not.toEqual(a)
  })

  it('FR-ACC-4: a short group is filled from the nearest groups', async () => {
    await leadsWith(
      db,
      Array.from({ length: 24 }, () => 56),
    )
    const sample = await calibrationSample(db, ACC, RULES_V1, 1)
    expect(sample).toHaveLength(20)
  })

  it('FR-ACC-4: leads without a live score can still be asked about', async () => {
    await leadsWith(
      db,
      Array.from({ length: 12 }, () => 56),
    )
    await db.execute(sql`delete from core.lead_score`)
    expect(await calibrationSample(db, ACC, RULES_V1, 1)).toHaveLength(12)
  })
})

describe('calibration marks', { timeout: 60000 }, () => {
  it('FR-ACC-4: fewer than 10 leads is too_few with the number there are, none at all is no_leads', async () => {
    expect(await startCalibration(db, { accountId: ACC, rules: RULES_V1 })).toEqual({
      ok: false,
      error: 'no_leads',
      have: 0,
    })
    await leadsWith(
      db,
      Array.from({ length: 9 }, () => 60),
    )
    expect(await startCalibration(db, { accountId: ACC, rules: RULES_V1 })).toEqual({
      ok: false,
      error: 'too_few',
      have: 9,
    })
    await leadsWith(db, [60], 9)
    const r = await startCalibration(db, { accountId: ACC, rules: RULES_V1 })
    expect(r).toMatchObject({ ok: true, total: 10 })
  })

  it('FR-ACC-4: a started calibration waits for Boris with its sample kept in the run', async () => {
    await leadsWith(db, MIX)
    const r = await startCalibration(db, { accountId: ACC, rules: RULES_V1, seed: 7 })
    if (!r.ok) throw new Error('no run')
    const run = await getRun(db, r.runId)
    expect(run).toMatchObject({ kind: 'calibration', state: 'marking', total: 20, seed: 7 })
    expect(run?.leadIds).toEqual(await calibrationSample(db, ACC, RULES_V1, 7))
    const view = await calibrationView(db, r.runId)
    expect(view.items.map((i) => i.leadId)).toEqual(run?.leadIds)
  })

  it('FR-ACC-4: the screen never gets the score or the decision while Boris marks', async () => {
    await leadsWith(db, MIX)
    const r = await startCalibration(db, { accountId: ACC, rules: RULES_V1 })
    if (!r.ok) throw new Error('no run')
    const text = JSON.stringify(await calibrationView(db, r.runId))
    for (const word of ['score', 'decision', 'reason', 'axes', 'threshold'])
      expect(text).not.toContain(word)
    expect(text).toContain('Реклама на ТВ')
  })

  it('FR-ACC-4: marking the same lead again replaces the mark and counts it once', async () => {
    await leadsWith(db, MIX)
    const r = await startCalibration(db, { accountId: ACC, rules: RULES_V1 })
    if (!r.ok) throw new Error('no run')
    const first = (await calibrationView(db, r.runId)).items[0]?.leadId ?? ''
    expect(await markItem(db, r.runId, first, 'yes')).toMatchObject({
      ok: true,
      marked: 1,
      total: 20,
    })
    expect(await markItem(db, r.runId, first, 'no')).toMatchObject({
      ok: true,
      marked: 1,
      total: 20,
    })
    expect((await calibrationView(db, r.runId)).items[0]?.mark).toBe('no')
  })

  it('FR-ACC-4: the last mark sends the run to scoring, and a mark outside the sample or a finished run is refused', async () => {
    await leadsWith(db, MIX)
    const r = await startCalibration(db, { accountId: ACC, rules: RULES_V1 })
    if (!r.ok) throw new Error('no run')
    const ids = (await calibrationView(db, r.runId)).items.map((i) => i.leadId)
    expect(await markItem(db, r.runId, 'nope', 'yes')).toEqual({ ok: false, error: 'no_item' })
    for (const [i, id] of ids.entries()) {
      const m = await markItem(db, r.runId, id, 'yes')
      expect(m).toMatchObject({ ok: true, marked: i + 1, complete: i === ids.length - 1 })
    }
    expect((await getRun(db, r.runId))?.state).toBe('queued')
    expect(await markItem(db, r.runId, ids[0] ?? '', 'no')).toEqual({
      ok: false,
      error: 'not_marking',
    })
  })
})

describe('calibration result', { timeout: 120000 }, () => {
  const yes = (n: number) => Array.from({ length: n }, () => 'yes' as const)
  const no = (n: number) => Array.from({ length: n }, () => 'no' as const)
  const same = (n: number, v: number) => Array.from({ length: n }, () => v)

  it('FR-ACC-4: agreement counts yes and no only, and 17 of 20 passes the 85% target', async () => {
    expect(CALIBRATION_TARGET).toBe(0.85)
    // Sara shows everything: she agrees with Boris's 17 yes and not with his 3 no.
    const { runId } = await calibrate(db, ACC, [...yes(17), ...no(3)], same(20, 70))
    expect(await calibrationResult(db, runId)).toMatchObject({
      decisive: 20,
      unsure: 0,
      agreement: 0.85,
      passed: true,
      reliable: true,
    })
    expect((await getRun(db, runId))?.state).toBe('done')
  })

  it('FR-ACC-4: 16 of 20 does not pass', async () => {
    const { runId } = await calibrate(db, ACC, [...yes(16), ...no(4)], same(20, 70))
    expect(await calibrationResult(db, runId)).toMatchObject({
      agreement: 0.8,
      passed: false,
      reliable: true,
    })
  })

  it('FR-ACC-4: "не знаю" is out of the agreement, and fewer than 15 decisive marks is not reliable and not passed', async () => {
    const unsure = Array.from({ length: 8 }, () => 'unsure' as const)
    const { runId } = await calibrate(db, ACC, [...yes(12), ...unsure], same(20, 70))
    expect(await calibrationResult(db, runId)).toMatchObject({
      decisive: 12,
      unsure: 8,
      agreement: 1,
      reliable: false,
      passed: false,
    })
  })

  it('FR-ACC-4: lost leads (Sara drops, Boris would take) are listed before extra ones, each with the reasons', async () => {
    // The first four leads in the run's order: Sara shows 1, 2 and drops 3, 4; Boris: no, no, yes, yes.
    const boris = [...['no', 'no', 'yes', 'yes'], ...yes(16)] as ('yes' | 'no')[]
    const sara = [...[70, 70, 30, 30], ...same(16, 70)]
    const { runId, ids } = await calibrate(db, ACC, boris, sara)
    const r = await calibrationResult(db, runId)
    expect(r.misses.map((m) => m.kind)).toEqual([
      'sara_no_boris_yes',
      'sara_no_boris_yes',
      'sara_yes_boris_no',
      'sara_yes_boris_no',
    ])
    expect(r.misses[0]).toMatchObject({ leadId: ids[2], score: 30, note: null })
    expect(r.misses[0]?.reason).toBeTruthy()
    expect(r.misses[0]?.axes).toHaveLength(5)
  })

  it('FR-ACC-4: the threshold hint appears for a gain of 10 points and names the better threshold', async () => {
    // Boris would take the first ten (Sara scores them 40, below 56, and far enough from it not to be asked twice)
    // and not the last ten (30).
    const { runId } = await calibrate(
      db,
      ACC,
      [...yes(10), ...no(10)],
      [...same(10, 40), ...same(10, 30)],
    )
    const r = await calibrationResult(db, runId)
    expect(r.agreement).toBe(0.5)
    expect(r.thresholdHint).toEqual({ from: 56, to: 40, before: 0.5, after: 1 })
  })

  it('FR-ACC-4: no threshold hint when another threshold gains less than 10 points', async () => {
    const { runId } = await calibrate(db, ACC, [...yes(19), ...no(1)], same(20, 70))
    expect((await calibrationResult(db, runId)).thresholdHint).toBeNull()
  })

  it('FR-ACC-4: a note on a miss is kept', async () => {
    const { runId, ids } = await calibrate(db, ACC, [...no(1), ...yes(19)], same(20, 70))
    const { setNote } = await import('../../src/direction/calibration')
    await setNote(db, runId, ids[0] ?? '', 'копеечный бюджет')
    expect((await calibrationResult(db, runId)).misses[0]?.note).toBe('копеечный бюджет')
  })
})
