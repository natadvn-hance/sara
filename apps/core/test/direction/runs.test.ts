import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../src/db/client'
import { directionRun, lead } from '../../src/db/schema'
import { recomputePool, recomputeResult } from '../../src/direction/recompute'
import { createRun, getRun, resumeRuns, runWorker } from '../../src/direction/runs'
import { seedDirection } from '../../src/direction/store'
import { trialScore } from '../../src/direction/trial'
import { RULES_V1 } from '../../src/direction/v1'
import { type Gateway, withoutLimitWait } from '../../src/gateway/gateway'
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

/** The database, except that its n-th call of `method` fails once: a blip in the middle of a run. */
function flaky(real: Db, method: 'select' | 'update', n: number): Db {
  let calls = 0
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === method) {
        return (...args: unknown[]) => {
          if (++calls === n) throw new Error('db blip')
          return (target[method] as (...a: unknown[]) => unknown)(...args)
        }
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as Db
}

describe('direction runs that go wrong', { timeout: 60000 }, () => {
  it('FR-ACC-5: a database blip at the start of a run does not reject the worker, and the run ends failed', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    const id = await newRun()
    await expect(
      runWorker({ db: flaky(db, 'update', 1), gateway: f.gateway, rolesDir: f.rolesDir }, id),
    ).resolves.toBeUndefined()
    expect(await getRun(db, id)).toMatchObject({ state: 'failed', stopReason: 'error' })
  })

  it('FR-ACC-5: a run that cannot even be read on restart is not an unhandled rejection', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    await newRun()
    const seen: unknown[] = []
    const on = (e: unknown) => seen.push(e)
    process.on('unhandledRejection', on)
    try {
      // The first select lists the waiting runs; the second is the worker reading its run.
      await resumeRuns({ db: flaky(db, 'select', 2), gateway: f.gateway, rolesDir: f.rolesDir })
      await new Promise((r) => setTimeout(r, 500))
    } finally {
      process.off('unhandledRejection', on)
    }
    expect(seen).toEqual([])
  })

  it('FR-ACC-5: a run nobody has touched for half an hour no longer blocks the next one', async () => {
    const stuck = await newRun()
    await db.execute(
      sql`update core.direction_run set state = 'running', updated_at = now() - interval '31 minutes' where id = ${stuck}`,
    )
    const next = await createRun(db, {
      accountId: ACC,
      kind: 'recompute',
      rules: CANDIDATE,
      baseRules: RULES_V1,
      leadIds: ['961001'],
    })
    expect(next.ok).toBe(true)
    expect(await getRun(db, stuck)).toMatchObject({ state: 'failed', stopReason: 'stale' })
  })

  it('FR-ACC-5: a run that still beats, or waits its turn, keeps blocking', async () => {
    const running = await newRun()
    await db.execute(
      sql`update core.direction_run set state = 'running', updated_at = now() - interval '5 minutes' where id = ${running}`,
    )
    const make = () =>
      createRun(db, {
        accountId: ACC,
        kind: 'recompute',
        rules: CANDIDATE,
        baseRules: RULES_V1,
        leadIds: ['961001'],
      })
    expect(await make()).toEqual({ ok: false, error: 'busy' })
    // A queued run may wait behind a long one: an hour is not too long, four hours is.
    await db.execute(
      sql`update core.direction_run set state = 'queued', updated_at = now() - interval '1 hour' where id = ${running}`,
    )
    expect(await make()).toEqual({ ok: false, error: 'busy' })
    await db.execute(
      sql`update core.direction_run set updated_at = now() - interval '4 hours' where id = ${running}`,
    )
    expect((await make()).ok).toBe(true)
  })

  it('FR-ACC-5: every scored lead keeps the run alive', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    const id = await newRun()
    await db.execute(
      sql`update core.direction_run set updated_at = now() - interval '20 minutes' where id = ${id}`,
    )
    await runWorker({ db, ...f }, id)
    const [row] = await db.select().from(directionRun).where(eq(directionRun.id, id))
    expect(Date.now() - new Date(row?.updatedAt ?? 0).getTime()).toBeLessThan(60_000)
  })

  it('FR-ACC-5: a run remembers the scorer version it scored with', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    const id = await newRun()
    expect((await getRun(db, id))?.scorerVersion).toBeNull()
    await runWorker({ db, ...f }, id)
    const meta = JSON.parse(
      await (await import('node:fs/promises')).readFile(`${f.rolesDir}/scorer/meta.json`, 'utf8'),
    ) as { version: number }
    expect((await getRun(db, id))?.scorerVersion).toBe(meta.version)
  })

  it('FR-ACC-5: the result reads only the scores of the version the run used', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    const id = await newRun()
    await runWorker({ db, ...f }, id)
    expect((await recomputeResult(db, id)).checked).toBe(3)
    // An older prompt's scores for the same rules are not this run's, even when newer ones are gone.
    await db.execute(sql`update core.trial_score set role_version = role_version - 1`)
    const r = await recomputeResult(db, id)
    expect(r.checked).toBe(0)
    expect(r.skipped).toBe(3)
  })

  it('FR-ACC-5: a run that scored nothing is failed with a reason, not done', async () => {
    const f = await fakeGateway(db, { scorer: { oops: 1 } })
    const id = await newRun()
    await runWorker({ db, ...f }, id)
    expect(await getRun(db, id)).toMatchObject({
      state: 'failed',
      stopReason: 'nothing_scored',
      skipped: 3,
    })
  })

  it('FR-ACC-5: a run that scored some leads and missed others is done, with the misses counted', async () => {
    // Lead 1 scores both ways; lead 2's old rules miss (so no second call); lead 3 scores both ways.
    const f = await fakeGateway(db, {
      scorer: {
        $sequence: [
          scorerAnswer(70),
          scorerAnswer(70),
          { oops: 1 },
          scorerAnswer(70),
          scorerAnswer(70),
        ],
      },
    })
    const id = await newRun()
    await runWorker({ db, ...f }, id)
    expect(await getRun(db, id)).toMatchObject({ state: 'done', skipped: 1 })
  })

  it('FR-ACC-5: no Claude token stops the run with its own reason instead of skipping every lead', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    const unplugged: Gateway = {
      call: async () => ({
        ok: false,
        errorClass: 'not_connected',
        message: 'no Claude token',
        durationMs: 0,
        modelCallId: 'x',
      }),
    }
    const id = await newRun()
    await runWorker({ db, gateway: unplugged, rolesDir: f.rolesDir }, id)
    expect(await getRun(db, id)).toMatchObject({ state: 'stopped', stopReason: 'not_connected' })
  })

  it('FR-ACC-5: when the old rules could not be scored the new ones are not scored for nothing', async () => {
    const f = await fakeGateway(db, { scorer: { $sequence: [{ oops: 1 }, scorerAnswer(70)] } })
    const id = await newRun()
    await runWorker({ db, ...f }, id)
    // Lead 1: the old rules missed, so no second call; leads 2 and 3 take the next two answers.
    expect((await f.calls()).length).toBe(1 + 2 + 2)
  })
})
