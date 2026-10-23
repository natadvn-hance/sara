import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { outboxNode } from '../src/db/schema'
import { createConnectionGuard } from '../src/watch/connectionGuard'
import { openNodeTestDb, resetNodeDb } from './helpers/db'

const { db, close } = openNodeTestDb()
afterAll(close)
beforeEach(() => resetNodeDb(db))

const MIN = 60_000
const t0 = Date.parse('2026-10-23T10:00:00.000Z')
const types = async () =>
  (await db.select().from(outboxNode)).map((r) => (r.payload as { type: string }).type)

function guard(backs: string[] = []) {
  return createConnectionGuard({
    db,
    accountId: 'hance-marketing',
    onBack: async (since) => {
      backs.push(since)
    },
  })
}

describe('connection guard', () => {
  it('ADR-021: a short outage under 30 minutes sends nothing to Boris', async () => {
    const backs: string[] = []
    const g = guard(backs)
    await g.report(false, t0)
    await g.tick(t0 + 10 * MIN)
    await g.report(true, t0 + 15 * MIN)
    expect(await types()).toEqual([])
    expect(backs).toHaveLength(1)
  })

  it('ADR-021: a long outage sends one lost and one back message', async () => {
    const g = guard()
    await g.report(false, t0)
    for (const m of [5, 10, 30, 35, 40, 120]) {
      await g.tick(t0 + m * MIN)
      await g.report(false, t0 + m * MIN)
    }
    expect(g.online()).toBe(false)
    await g.report(true, t0 + 125 * MIN)
    await g.tick(t0 + 126 * MIN)
    expect(await types()).toEqual(['profi.connection_lost', 'profi.connection_back'])
  })

  it('ADR-021: while offline the tab may touch the site only once per 5 minutes', async () => {
    const g = guard()
    expect(g.mayNavigate(t0)).toBe(true)
    await g.report(false, t0)
    const allowed = []
    for (let s = 30; s <= 10 * 60; s += 30) {
      const now = t0 + s * 1000
      if (g.mayNavigate(now)) {
        allowed.push(s)
        await g.report(false, now)
      }
    }
    expect(allowed).toEqual([300, 600])
  })
})
