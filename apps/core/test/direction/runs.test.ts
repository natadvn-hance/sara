import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lead } from '../../src/db/schema'
import { recomputePool } from '../../src/direction/recompute'
import { createRun, getRun, resumeRuns, runWorker } from '../../src/direction/runs'
import { seedDirection } from '../../src/direction/store'
import { trialScore } from '../../src/direction/trial'
import { RULES_V1 } from '../../src/direction/v1'
import { withoutLimitWait } from '../../src/gateway/gateway'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'
import { fakeGateway } from '../helpers/gateway'
import { leadWithScore } from '../helpers/learning'
import { scorerAnswer } from '../helpers/scorer'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
const CANDIDATE = { ...RULES_V1, threshold: 50 }
beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, ACC)
  for (const [i, id] of ['961001', '961002', '961003'].entries()) {
    await leadWithScore(db, id, 70)
    await db
      .update(lead)
      .set({ seenAt: new Date(Date.now() - i * 60_000).toISOString() })
      .where(sql`id = ${id}`)
  }
})

const newRun = async () => {
  const made = await createRun(db, {
    accountId: ACC,
    kind: 'recompute',
    rules: CANDIDATE,
    baseRules: RULES_V1,
    leadIds: await recomputePool(db, ACC),
  })
  if (!made.ok) throw new Error('busy')
  return made.id
}

describe('direction runs', { timeout: 60000 }, () => {
  it('FR-ACC-5: a run counts its progress as leads are scored', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    const id = await newRun()
    expect(await getRun(db, id)).toMatchObject({ state: 'queued', total: 3, done: 0 })
    const seen: number[] = []
    await runWorker({ db, ...f }, id, { onProgress: (done) => seen.push(done) })
    expect(seen).toEqual([1, 2, 3])
    expect(await getRun(db, id)).toMatchObject({
      state: 'done',
      total: 3,
      done: 3,
      stopReason: null,
    })
  })

  it('FR-ACC-5: a restart continues a running run without scoring the finished leads again', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    const id = await newRun()
    // The first lead was scored before the restart (both rules); the run was running.
    const d = { db, ...f }
    await trialScore(d, '961001', RULES_V1, 'plain')
    await trialScore(d, '961001', CANDIDATE, 'plain')
    await db.execute(
      sql`update core.direction_run set state = 'running', done = 1 where id = ${id}`,
    )
    const before = (await f.calls()).length
    await resumeRuns(d)
    await waitFor(async () => (await getRun(db, id))?.state === 'done')
    expect((await f.calls()).length - before).toBe(4)
  })

  it('FR-ACC-5: the Claude limit stops the run with a reason and no waiting', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) }, { FAKE_CLAUDE_MODE: 'limit' })
    const id = await newRun()
    const started = Date.now()
    await runWorker({ db, gateway: withoutLimitWait(f.gateway), rolesDir: f.rolesDir }, id)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await getRun(db, id)).toMatchObject({ state: 'stopped', stopReason: 'limit' })
  })

  it('FR-ACC-5: a run is journaled when it ends', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    const id = await newRun()
    await runWorker({ db, ...f }, id)
    expect(await countEvents(db, 'direction.run_finished')).toBe(1)
  })

  it('FR-ACC-5: a second run does not start while one is waiting or running', async () => {
    const first = await newRun()
    const second = await createRun(db, {
      accountId: ACC,
      kind: 'recompute',
      rules: CANDIDATE,
      baseRules: RULES_V1,
      leadIds: ['961001'],
    })
    expect(second).toEqual({ ok: false, error: 'busy' })
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    await runWorker({ db, ...f }, first)
    expect(
      (
        await createRun(db, {
          accountId: ACC,
          kind: 'recompute',
          rules: CANDIDATE,
          baseRules: RULES_V1,
          leadIds: ['961001'],
        })
      ).ok,
    ).toBe(true)
  })

  it('FR-ACC-5: two runs created at the same moment give one', async () => {
    const make = () =>
      createRun(db, {
        accountId: ACC,
        kind: 'recompute',
        rules: CANDIDATE,
        baseRules: RULES_V1,
        leadIds: ['961001'],
      })
    const results = await Promise.all([make(), make(), make()])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  it('FR-ACC-5: a run that crashed is marked failed and the next one can start', async () => {
    const broken = await fakeGateway(db, { scorer: scorerAnswer(70) })
    const id = await newRun()
    const throwing = {
      call: async () => {
        throw new Error('boom')
      },
    }
    await runWorker({ db, gateway: throwing, rolesDir: broken.rolesDir }, id)
    expect(await getRun(db, id)).toMatchObject({ state: 'failed' })
    expect(
      (
        await createRun(db, {
          accountId: ACC,
          kind: 'recompute',
          rules: CANDIDATE,
          baseRules: RULES_V1,
          leadIds: ['961001'],
        })
      ).ok,
    ).toBe(true)
  })
})

async function waitFor(f: () => Promise<boolean>, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timed out')
}
