import { newEventId } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bidHold, lead, task } from '../../src/db/schema'
import { cancelHold, HOLD_TEXTS, holdBid, setHoldDeps } from '../../src/leads/hold'
import type { Press } from '../../src/tasks/resolve'
import { launchDbos, shutdownDbos } from '../../src/workflows/dbos'
import { openTestDb, resetDb, testDatabaseUrl } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()

const LEAD = '95000031'
const TASK = '66666666-6666-4666-8666-666666666631'
let presses: Press[] = []
let told: string[] = []
/** What the press does to the task: decide it (a bid went), or leave it open (a pause). */
let pressDecides = true

beforeAll(async () => {
  await launchDbos(testDatabaseUrl())
})
afterAll(async () => {
  await shutdownDbos()
  await close()
})

beforeEach(async () => {
  await resetDb(db)
  presses = []
  told = []
  pressDecides = true
  setHoldDeps({
    db,
    holdMs: 400,
    press: async (p) => {
      presses.push(p)
      if (!pressDecides) return 'Отправка откликов на паузе. Включи её и нажми снова.'
      await db
        .update(task)
        .set({ state: 'resolved', resolution: 'bid', resolvedAt: new Date().toISOString() })
        .where(eq(task.id, p.taskId))
      return 'Отправляю отклик'
    },
    notifier: {
      sendText: async (text) => {
        told.push(text)
        return { messageId: 1 }
      },
    },
  })
  await db.insert(lead).values({
    id: LEAD,
    accountId: 'hance-marketing',
    title: 'Стратегия для пекарни',
    category: 'Маркетинг',
    city: 'Краснодар',
    text: 'Нужна стратегия.',
    clientName: 'Ирина',
    bidPriceRub: 210,
    seenAt: new Date().toISOString(),
    status: 'queued',
    correlationId: newEventId(),
    draftText: 'Ирина, добрый день! ...',
    draftPriceRub: 30000,
  })
  await db
    .insert(task)
    .values({ id: TASK, kind: 'lead_decision', entityKind: 'lead', entityId: LEAD })
})

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timed out')
}
const stateOf = async () =>
  (await db.select().from(bidHold).where(eq(bidHold.taskId, TASK)))[0]?.state

describe('a bid from the pult waits ten seconds in the core (ST-M7-04)', () => {
  it('FR-LEAD-8, ST-M7-04: the press is held, a second tap is the same hold, and the bid fires by itself after the wait', async () => {
    const first = await holdBid(LEAD, 210)
    expect(first).toMatchObject({ ok: true, message: HOLD_TEXTS.held(210) })
    const second = await holdBid(LEAD, 210)
    expect(second.ok && first.ok && second.executeAt).toBe(first.ok && first.executeAt)
    expect(await stateOf()).toBe('held')
    expect(await countEvents(db, 'bid.held', LEAD)).toBe(1)
    expect(presses).toEqual([])
    // Nobody is on the screen any more: the core fires it alone.
    await until(() => presses.length === 1)
    expect(presses[0]).toEqual({ taskId: TASK, action: 'bid', source: 'hold' })
    expect(await stateOf()).toBe('fired')
    expect(await cancelHold(LEAD)).toEqual({ ok: false, message: HOLD_TEXTS.gone })
  })

  it('ST-M7-04: «Отменить» before the end stops the bid and says so; nothing is pressed afterwards', async () => {
    await holdBid(LEAD, 210)
    expect(await cancelHold(LEAD)).toEqual({ ok: true, message: HOLD_TEXTS.cancelled })
    expect(await stateOf()).toBe('cancelled')
    expect(await countEvents(db, 'bid.hold_cancelled', LEAD)).toBe(1)
    await new Promise((r) => setTimeout(r, 900))
    expect(presses).toEqual([])
    expect(await cancelHold(LEAD)).toEqual({ ok: false, message: HOLD_TEXTS.nothing })
    // A new press after the cancel is a new hold.
    expect((await holdBid(LEAD, 210)).ok).toBe(true)
    await until(() => presses.length === 1)
  })

  it('ST-M7-04: a price that changed while the screen was open is refused and nothing is held', async () => {
    const r = await holdBid(LEAD, 180)
    expect(r).toMatchObject({ ok: false, status: 409, code: 'fee_changed' })
    expect(await stateOf()).toBeUndefined()
  })

  it('ST-M7-04: a lead decided elsewhere (in Telegram) is not held', async () => {
    await db.update(task).set({ state: 'resolved', resolution: 'skip' }).where(eq(task.id, TASK))
    expect(await holdBid(LEAD, 210)).toMatchObject({
      ok: false,
      status: 409,
      message: HOLD_TEXTS.decided,
    })
  })

  it('FR-LEAD-9: a held bid the press refused (a pause) is told to Boris, and the card stays open', async () => {
    pressDecides = false
    await holdBid(LEAD, 210)
    await until(() => told.length === 1)
    expect(told[0]).toBe(
      HOLD_TEXTS.notSent(
        'Стратегия для пекарни',
        'Отправка откликов на паузе. Включи её и нажми снова.',
      ),
    )
    const [t] = await db.select().from(task).where(eq(task.id, TASK))
    expect(t?.state).toBe('open')
    // One row per task: the next press replaces the fired hold with a new one.
    expect((await holdBid(LEAD, 210)).ok).toBe(true)
    expect(await stateOf()).toBe('held')
    const [{ n } = { n: 0 }] = (
      await db.execute<{ n: number }>(sql`select count(*)::int as n from core.bid_hold`)
    ).rows
    expect(n).toBe(1)
  })
})
