import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { lead, task } from '../src/db/schema'
import { startStaleSweep } from '../src/leads/staleCards'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const H = 3600_000
const NOW = new Date('2026-10-30T12:00:00Z')
const old = (h: number) => new Date(NOW.getTime() - h * H).toISOString()

const closed: string[] = []
let fails = new Set<string>()
const sweep = (o: { perPass?: number } = {}) =>
  startStaleSweep({
    db,
    close: async (taskId) => {
      if (fails.has(taskId)) throw new Error('could not close')
      closed.push(taskId)
      return true
    },
    tickMs: 3_600_000,
    ...o,
  })

let n = 0
beforeEach(async () => {
  await resetDb(db)
  closed.length = 0
  fails = new Set()
  n = 0
})

/** A waiting decision: its order seen `seen` hours ago and its task made `made` hours ago. */
async function waiting(seen: number, made: number, o: { kind?: string; state?: string } = {}) {
  const id = `9500${++n}`
  const taskId = newEventId()
  await db.insert(lead).values({
    id,
    accountId: 'hance-marketing',
    title: 'Сайт',
    category: 'Сайты',
    city: 'Краснодар',
    text: 'Нужен сайт',
    clientName: 'Ирина',
    budgetText: null,
    bidPriceRub: 210,
    seenAt: old(seen),
    status: 'queued',
    correlationId: newEventId(),
  })
  await db.insert(task).values({
    id: taskId,
    kind: o.kind ?? 'lead_decision',
    entityKind: 'lead',
    entityId: id,
    state: o.state ?? 'open',
    createdAt: old(made),
  })
  return taskId
}

describe('the sweep of cards that waited more than a day (FR-LEAD-10)', () => {
  it('FR-LEAD-10: only open decisions whose order and card are both older than a day are ended', async () => {
    const a = await waiting(30, 30)
    await waiting(23, 23)
    await waiting(40, 3)
    await waiting(30, 30, { state: 'resolved' })
    await waiting(30, 30, { kind: 'lead_held' })
    expect(await sweep().tick(NOW)).toEqual({ closed: 1 })
    expect(closed).toEqual([a])
  })

  it('FR-LEAD-10: the oldest go first, a few at a time: a backlog leaves over several passes', async () => {
    const ids = []
    for (const h of [100, 50, 200, 75]) ids.push({ h, id: await waiting(h, h) })
    const job = sweep({ perPass: 3 })
    expect(await job.tick(NOW)).toEqual({ closed: 3 })
    expect(closed).toEqual(
      ids
        .sort((x, y) => y.h - x.h)
        .slice(0, 3)
        .map((x) => x.id),
    )
    // Those ended in the pass are not asked again; the rest follow.
    const next = new Set(closed)
    closed.length = 0
    await db
      .update(task)
      .set({ state: 'resolved' })
      .where(eq(task.id, [...next][0] ?? ''))
    expect((await job.tick(NOW)).closed).toBeGreaterThan(0)
  })

  it('FR-LEAD-10: a card that fails to end does not stop the others, and the failure is logged', async () => {
    const a = await waiting(90, 90)
    const b = await waiting(80, 80)
    fails = new Set([a])
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(sweep().tick(NOW)).resolves.toEqual({ closed: 1 })
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
    expect(closed).toEqual([b])
  })

  it('FR-LEAD-10: it runs by itself on its tick, one pass at a time, at any hour of the day', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const a = await waiting(90, 90)
      let release: () => void = () => {}
      let asked = 0
      const job = startStaleSweep({
        db,
        close: async (taskId) => {
          asked++
          await new Promise<void>((r) => {
            release = r
          })
          closed.push(taskId)
          return true
        },
        now: () => new Date('2026-10-30T01:00:00Z'),
        tickMs: 1000,
      })
      await vi.advanceTimersByTimeAsync(1000)
      await vi.waitFor(() => expect(asked).toBe(1))
      await vi.advanceTimersByTimeAsync(3000)
      expect(asked).toBe(1)
      release()
      await vi.waitFor(() => expect(closed).toEqual([a]))
      job.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
