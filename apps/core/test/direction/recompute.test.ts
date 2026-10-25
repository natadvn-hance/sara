import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lead, leadLabel, leadScore } from '../../src/db/schema'
import { recomputePool, recomputeResult } from '../../src/direction/recompute'
import { createRun, getRun, runWorker } from '../../src/direction/runs'
import { seedDirection } from '../../src/direction/store'
import { RULES_V1 } from '../../src/direction/v1'
import { openTestDb, resetDb } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'
import { leadWithScore } from '../helpers/learning'
import { scorerAnswer } from '../helpers/scorer'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, ACC)
})

/** `n` scored leads, 960001 the newest, each one minute older than the one before. */
async function leads(n: number) {
  for (let i = 1; i <= n; i++) {
    const id = String(960000 + i)
    await leadWithScore(db, id, 70)
    await db
      .update(lead)
      .set({ seenAt: new Date(Date.now() - i * 60_000).toISOString() })
      .where(sql`id = ${id}`)
  }
}
const CANDIDATE = { ...RULES_V1, threshold: 56, notes: ['другое уточнение'] }

describe('recompute pool', { timeout: 30000 }, () => {
  it('FR-ACC-5: the last 50 scored leads are the pool, newest first, fewer are all of them', async () => {
    await leads(55)
    const pool = await recomputePool(db, ACC)
    expect(pool).toHaveLength(50)
    expect(pool[0]).toBe('960001')
    expect(pool[49]).toBe('960050')
    await resetDb(db)
    await leads(3)
    expect(await recomputePool(db, ACC)).toEqual(['960001', '960002', '960003'])
  })

  it('FR-ACC-5: sorted-out and stale leads, leads without a live score and other accounts are not in it', async () => {
    await leads(6)
    await db.update(lead).set({ status: 'sorted_out' }).where(sql`id = '960001'`)
    await db.update(lead).set({ status: 'stale' }).where(sql`id = '960002'`)
    await db.update(lead).set({ accountId: 'hance-it' }).where(sql`id = '960003'`)
    await db.delete(leadScore).where(sql`lead_id = '960004'`)
    // A trial row of an earlier proposal is not a live score.
    await db.update(leadScore).set({ backtest: true }).where(sql`lead_id = '960005'`)
    expect(await recomputePool(db, ACC)).toEqual(['960006'])
  })
})

describe('recompute result', { timeout: 60000 }, () => {
  async function run(answers: unknown[], env: Record<string, string> = {}) {
    const f = await fakeGateway(db, { scorer: { $sequence: answers } }, env)
    const made = await createRun(db, {
      accountId: ACC,
      kind: 'recompute',
      rules: CANDIDATE,
      baseRules: RULES_V1,
      leadIds: await recomputePool(db, ACC),
    })
    if (!made.ok) throw new Error('busy')
    await runWorker({ db, ...f }, made.id)
    return { f, id: made.id }
  }

  it('FR-ACC-5: the result lists only leads whose decision changed, with the scores before and after', async () => {
    await leads(2)
    // Per lead: the old rules first, then the new ones.
    const { id } = await run([
      scorerAnswer(70), // 960001 before: show
      scorerAnswer(70), // 960001 after: show, unchanged
      scorerAnswer(70), // 960002 before: show
      scorerAnswer(40), // 960002 after: drop, changed
    ])
    const r = await recomputeResult(db, id)
    expect(r).toMatchObject({ checked: 2, skipped: 0, changed: 1, toDrop: 1, toShow: 0 })
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({
      leadId: '960002',
      before: { score: 70, decision: 'show' },
      after: { score: 40, decision: 'drop' },
    })
    expect(r.items[0]?.after.axes).toHaveLength(5)
  })

  it('FR-ACC-5: before and after are scored on the same model, haiku, even near the threshold', async () => {
    await leads(1)
    const { f } = await run([scorerAnswer(56), scorerAnswer(56)])
    expect((await f.calls()).map((c) => c.model)).toEqual(['haiku', 'haiku'])
  })

  it("FR-ACC-5: Boris's decisions show next to the changed leads and the agreement before and after", async () => {
    await leads(3)
    await db.insert(leadLabel).values([
      { leadId: '960001', label: 'yes', source: 'card' },
      { leadId: '960002', label: 'no', source: 'card' },
      { leadId: '960003', label: 'weak_no', source: 'ignored' },
    ])
    const { id } = await run([
      scorerAnswer(70), // 960001 before show (Boris yes: agrees)
      scorerAnswer(70), // 960001 after show
      scorerAnswer(70), // 960002 before show (Boris no: disagrees)
      scorerAnswer(40), // 960002 after drop (agrees now)
      scorerAnswer(70), // 960003
      scorerAnswer(70),
    ])
    const r = await recomputeResult(db, id)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]?.boris).toBe('no')
    // Two leads carry a decision of his; the weak no is not one.
    expect(r.withBoris).toBe(2)
    expect(r.agreementBefore).toBe(0.5)
    expect(r.agreementAfter).toBe(1)
  })

  it('FR-ACC-5: a lead the model could not score is skipped and counted', async () => {
    await leads(2)
    const { id } = await run([
      { oops: 1 }, // 960001 before: not a score (twice with the retry? the scorer asks once)
      scorerAnswer(70),
      scorerAnswer(70),
      scorerAnswer(70),
    ])
    const r = await recomputeResult(db, id)
    expect(r.checked + r.skipped).toBe(2)
    expect(r.skipped).toBe(1)
    expect((await getRun(db, id))?.state).toBe('done')
  })
})
