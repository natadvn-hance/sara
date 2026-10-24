import { DirectionRules, weightedScore } from '@sara/shared'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { activeRules, addVersion, rollbackTo, seedDirection } from '../src/direction/store'
import { RULES_V1 } from '../src/direction/v1'
import { openTestDb, resetDb } from './helpers/db'
import { countEvents } from './helpers/events'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const ACC = 'hance-marketing'
const versions = async () =>
  (
    await db.execute<{ version: number; active: boolean }>(
      sql`select version, active from core.direction_version where account_id = ${ACC} order by version`,
    )
  ).rows

describe('direction rules', () => {
  it("FR-ACC-2: v1 holds old Sara's five axes, weights 30/25/20/15/10 and threshold 56", () => {
    expect(RULES_V1.axes.map((a) => [a.id, a.weight])).toEqual([
      ['client', 30],
      ['system', 25],
      ['budget', 20],
      ['competition', 15],
      ['ltv', 10],
    ])
    expect(RULES_V1.threshold).toBe(56)
    const ids = RULES_V1.stop_factors.map((s) => s.id)
    expect(ids).toEqual(
      expect.arrayContaining(['direct', 'narrow_tool', 'vacancy', 'percent', 'one_off_tech']),
    )
    expect(RULES_V1.stop_factors.find((s) => s.id === 'narrow_tool')?.exception).toBeTruthy()
    expect(DirectionRules.safeParse(RULES_V1).success).toBe(true)
  })

  it('FR-ACC-2: rules whose weights do not add up to 100 are refused', () => {
    const axes = RULES_V1.axes.map((a, i) => (i === 0 ? { ...a, weight: 31 } : a))
    expect(DirectionRules.safeParse({ ...RULES_V1, axes }).success).toBe(false)
  })

  it('FR-LEAD-3: the score is the weighted sum of the axes', () => {
    expect(
      weightedScore(RULES_V1, { client: 80, system: 60, budget: 50, competition: 40, ltv: 30 }),
    ).toBe(58)
    expect(() => weightedScore(RULES_V1, { client: 80 })).toThrow()
  })

  it('FR-ACC-2: the seed writes v1 once and it is the active version', async () => {
    await seedDirection(db, ACC)
    await seedDirection(db, ACC)
    const a = await activeRules(db, ACC)
    expect(a.version).toBe(1)
    expect(a.rules.threshold).toBe(56)
    expect(await versions()).toEqual([{ version: 1, active: true }])
    expect(await countEvents(db, 'direction.version_created')).toBe(1)
  })

  it('FR-MIND-3: a rollback is a new version with the old rules, history kept', async () => {
    await seedDirection(db, ACC)
    expect(
      await addVersion(db, {
        accountId: ACC,
        rules: { ...RULES_V1, threshold: 60 },
        createdBy: 'boris',
        reason: 'порог выше',
      }),
    ).toBe(2)
    expect((await activeRules(db, ACC)).rules.threshold).toBe(60)
    expect(await rollbackTo(db, ACC, 1)).toBe(3)
    const a = await activeRules(db, ACC)
    expect(a).toMatchObject({ version: 3, rules: { threshold: 56 } })
    expect(await versions()).toEqual([
      { version: 1, active: false },
      { version: 2, active: false },
      { version: 3, active: true },
    ])
    const [r] = (
      await db.execute<{ reason: string }>(
        sql`select reason from core.direction_version where version = 3`,
      )
    ).rows
    expect(r?.reason).toBe('откат к v1')
  })
})
