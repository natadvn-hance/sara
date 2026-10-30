import { type GetOrderOutput, newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lead, task } from '../../src/db/schema'
import { createRecheckOne, RECHECK_TEXTS } from '../../src/leads/recheckOne'
import { ProfiError } from '../../src/profi/client'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)

const LEAD = '95000041'
const TASK = '77777777-7777-4777-8777-777777777741'
let page: Partial<GetOrderOutput> | Error = {}
let closed: string[] = []
let clock = new Date('2026-10-29T12:00:00Z')

const profi = {
  getOrder: async (_account: string, orderId: string): Promise<GetOrderOutput> => {
    if (page instanceof Error) throw page
    return {
      order_id: orderId,
      title: 'Сайт',
      category: 'Сайты',
      city: 'Краснодар',
      text: 'Нужен сайт',
      client_name: 'Ирина',
      budget_text: null,
      bid_price_rub: 210,
      seen_at: clock.toISOString(),
      published_at: null,
      open: true,
      has_bid: false,
      from_page: true,
      ...page,
    } as GetOrderOutput
  },
}

const make = () =>
  createRecheckOne({
    db,
    profi,
    close: async (taskId) => {
      closed.push(taskId)
    },
    now: () => clock,
  })

beforeEach(async () => {
  await resetDb(db)
  page = {}
  closed = []
  clock = new Date('2026-10-29T12:00:00Z')
  await db.insert(lead).values({
    id: LEAD,
    accountId: 'hance-marketing',
    title: 'Сайт для пекарни',
    category: 'Сайты',
    city: 'Краснодар',
    text: 'Нужен сайт.',
    clientName: 'Ирина',
    bidPriceRub: 210,
    seenAt: clock.toISOString(),
    status: 'queued',
    correlationId: newEventId(),
  })
  await db
    .insert(task)
    .values({ id: TASK, kind: 'lead_decision', entityKind: 'lead', entityId: LEAD })
})

describe('«Перепроверить» on the lead screen', () => {
  it('FR-LEAD-5: an open order says so and the read counts as the last look of the hourly recheck', async () => {
    const recheck = make()
    expect(await recheck(LEAD)).toEqual({ message: RECHECK_TEXTS.open, closed: false })
    expect(await countEvents(db, 'lead.page_read', LEAD)).toBe(1)
  })

  it('FR-LEAD-5: a closed order closes its card, as the hourly recheck does', async () => {
    page = { open: false }
    expect(await make()(LEAD)).toEqual({ message: RECHECK_TEXTS.closed, closed: true })
    expect(closed).toEqual([TASK])
  })

  it('FR-LEAD-5: an order we already bid on is not taken for closed', async () => {
    page = { open: false, has_bid: true }
    expect((await make()(LEAD)).closed).toBe(false)
    expect(closed).toEqual([])
  })

  it('FR-LEAD-8: a new fee is kept on the lead, so the next press pays what the page asks', async () => {
    page = { bid_price_rub: 260 }
    expect((await make()(LEAD)).message).toBe(RECHECK_TEXTS.feeChanged(210, 260))
    const [l] = await db.select().from(lead).where(eq(lead.id, LEAD))
    expect(l?.bidPriceRub).toBe(260)
  })

  it('FR-LEAD-5: an answer from the node’s store, or a failed read, closes nothing', async () => {
    page = { open: false, from_page: false }
    expect(await make()(LEAD)).toEqual({ message: RECHECK_TEXTS.notRead, closed: false })
    page = new ProfiError('SESSION_DEAD', 'dead')
    clock = new Date(clock.getTime() + 6 * 60_000)
    const r = await make()(LEAD)
    expect(r.message).toBe(RECHECK_TEXTS.failed('Профи.ру разлогинил аккаунт'))
    expect(closed).toEqual([])
  })

  it('FR-LEAD-5: at most once in five minutes per lead, and never for a decided one', async () => {
    const recheck = make()
    await recheck(LEAD)
    expect((await recheck(LEAD)).message).toBe(RECHECK_TEXTS.tooSoon(5))
    clock = new Date(clock.getTime() + 5 * 60_000)
    expect((await recheck(LEAD)).message).toBe(RECHECK_TEXTS.open)
    await db.update(task).set({ state: 'resolved', resolution: 'skip' }).where(eq(task.id, TASK))
    expect((await recheck(LEAD)).message).toBe(RECHECK_TEXTS.decided)
  })
})
