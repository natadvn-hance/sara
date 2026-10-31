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

function guard(backs: string[] = [], accountId = 'hance-marketing') {
  return createConnectionGuard({
    db,
    accountId,
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

  // 29.10.2026: three deploys during an outage, three «lost», no «back», «Нет связи» on the pult for days.
  async function lostThenRestart(backs: string[] = []) {
    const before = guard()
    await before.report(false, t0)
    await before.tick(t0 + 31 * MIN)
    return guard(backs)
  }

  it('NFR-REL-3, ADR-021: after a restart the first page that opens sends the «back» for the «lost» already sent', async () => {
    const backs: string[] = []
    const g = await lostThenRestart(backs)
    await g.report(true, t0 + 60 * MIN)
    expect(await types()).toEqual(['profi.connection_lost', 'profi.connection_back'])
    const back = (await db.select().from(outboxNode))
      .map((r) => r.payload as { type: string; payload: { since: string } })
      .find((p) => p.type === 'profi.connection_back')
    expect(back?.payload.since).toBe(new Date(t0).toISOString())
    // The reconcile reads from the start of the outage, not from the restart.
    expect(backs).toEqual([new Date(t0).toISOString()])
    expect(g.online()).toBe(true)
  })

  it('NFR-REL-3, ADR-021: a restart while the site is still down sends no second «lost» and keeps the 5-minute pace', async () => {
    const g = await lostThenRestart()
    await g.tick(t0 + 40 * MIN)
    expect(g.online()).toBe(false)
    await g.report(false, t0 + 40 * MIN)
    expect(g.mayNavigate(t0 + 42 * MIN)).toBe(false)
    expect(g.mayNavigate(t0 + 45 * MIN)).toBe(true)
    await g.tick(t0 + 120 * MIN)
    await g.report(false, t0 + 120 * MIN)
    expect(await types()).toEqual(['profi.connection_lost'])
    await g.report(true, t0 + 125 * MIN)
    expect(await types()).toEqual(['profi.connection_lost', 'profi.connection_back'])
  })

  it('NFR-REL-3: a restart after the «back», or a «lost» of another account, starts online and sends nothing', async () => {
    const before = await lostThenRestart()
    await before.report(true, t0 + 60 * MIN)
    const backs: string[] = []
    const g = guard(backs)
    await g.report(true, t0 + 70 * MIN)
    const other = guard(backs, 'hance-other')
    await other.tick(t0 + 70 * MIN)
    await other.report(true, t0 + 71 * MIN)
    expect(other.online()).toBe(true)
    expect(await types()).toEqual(['profi.connection_lost', 'profi.connection_back'])
    expect(backs).toEqual([])
  })
})
