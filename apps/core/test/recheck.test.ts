import { type GetOrderOutput, newEventId } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { event, lead, task } from '../src/db/schema'
import { appendEvent } from '../src/journal/journal'
import { startCardRecheck } from '../src/leads/recheck'
import { TEXTS } from '../src/notify/cards'
import { ProfiError } from '../src/profi/client'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)

/** A Monday noon in Moscow: inside the recheck hours. */
const AT = new Date('2026-10-26T12:00:00+03:00')
const MIN = 60_000
const before = (min: number, from = AT) => new Date(from.getTime() - min * MIN)
const after = (min: number, from = AT) => new Date(from.getTime() + min * MIN)
const msk = (time: string, day = '2026-10-26') => new Date(`${day}T${time}+03:00`)

const reads: string[] = []
let pages: Record<string, Partial<GetOrderOutput> | Error> = {}
const profi = {
  getOrder: async (_account: string, orderId: string): Promise<GetOrderOutput> => {
    reads.push(orderId)
    const p = pages[orderId]
    if (p instanceof Error) throw p
    return {
      order_id: orderId,
      title: 'Сайт',
      category: 'Сайты',
      city: 'Краснодар',
      text: 'Нужен сайт',
      client_name: 'Ирина',
      budget_text: null,
      bid_price_rub: 0,
      seen_at: AT.toISOString(),
      published_at: null,
      open: true,
      has_bid: false,
      from_page: true,
      ...p,
    } as GetOrderOutput
  },
}
let said: string[] = []
let failSay = false
const notifier = {
  sendText: async (t: string) => {
    if (failSay) throw new Error('telegram is down')
    said.push(t)
    return { messageId: 1 }
  },
}
const closed: string[] = []
let closeFails = new Set<string>()
const closeCard = async (taskId: string) => {
  if (closeFails.has(taskId)) throw new Error('could not close')
  closed.push(taskId)
}
const recheck = (o: { perPass?: number } = {}) =>
  startCardRecheck({ db, profi, notifier, close: closeCard, tickMs: 3_600_000, ...o })

let n = 0
beforeEach(async () => {
  await resetDb(db)
  reads.length = 0
  closed.length = 0
  pages = {}
  said = []
  failSay = false
  closeFails = new Set()
  n = 0
})

type Seed = {
  /** Minutes before AT the card went out; null: no card.sent in the journal. */
  sent: number | null
  /** Minutes before AT of the last page read of the lead; none by default. */
  look?: number
  state?: string
  kind?: string
  messageId?: number | null
  createdMin?: number
}

/** A lead with a decision task and the journal of its card, as the pipeline leaves them. */
async function card(s: Seed) {
  const id = `8000${++n}`
  const correlationId = newEventId()
  const taskId = newEventId()
  await db.insert(lead).values({
    id,
    accountId: 'hance-marketing',
    title: 'Сайт для клиники',
    category: 'Сайты',
    city: 'Краснодар',
    text: 'Нужен сайт',
    clientName: 'Ирина',
    budgetText: null,
    bidPriceRub: 210,
    seenAt: AT.toISOString(),
    status: 'queued',
    correlationId,
  })
  await db.insert(task).values({
    id: taskId,
    kind: s.kind ?? 'lead_decision',
    entityKind: 'lead',
    entityId: id,
    state: s.state ?? 'open',
    telegramMessageId: s.messageId === undefined ? 5000 + n : s.messageId,
    ...(s.createdMin !== undefined && { createdAt: before(s.createdMin).toISOString() }),
  })
  const put = (
    type: 'card.sent' | 'lead.page_read',
    entity: { kind: string; id: string },
    min: number,
    payload: Record<string, unknown>,
  ) =>
    appendEvent(db, {
      type,
      v: 1,
      entity,
      account_id: 'hance-marketing',
      actor: 'sara',
      occurred_at: before(min).toISOString(),
      causation_id: null,
      correlation_id: correlationId,
      reason: null,
      payload,
    })
  if (s.sent !== null)
    await put('card.sent', { kind: 'task', id: taskId }, s.sent, {
      via: 'order',
      message_id: 5000 + n,
    })
  if (s.look !== undefined)
    await put('lead.page_read', { kind: 'lead', id }, s.look, { ok: true, open: true })
  return { id, taskId }
}

const pageReads = async (id: string) =>
  (
    await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, 'lead.page_read'), eq(event.entityId, id)))
      .orderBy(event.recordedAt, event.id)
  ).map((e) => e.payload)
const eventCount = async (type: string) =>
  (await db.select().from(event).where(eq(event.type, type))).length

describe('which waiting cards are looked at (FR-LEAD-5)', () => {
  it('FR-LEAD-5: the oldest look comes first, and no more than four pages are read in a pass', async () => {
    const a = await card({ sent: 300 })
    const b = await card({ sent: 180 })
    const c = await card({ sent: 240 })
    const d = await card({ sent: 120 })
    await card({ sent: 90 })
    await card({ sent: 80 })
    expect(await recheck().tick(AT)).toEqual({ checked: 4, closed: 0, doubt: false })
    expect(reads).toEqual([a.id, c.id, b.id, d.id])
  })

  it('FR-LEAD-5: the pass can be made smaller', async () => {
    await card({ sent: 300 })
    await card({ sent: 200 })
    await card({ sent: 100 })
    expect((await recheck({ perPass: 2 }).tick(AT)).checked).toBe(2)
  })

  it('FR-LEAD-5: a card is looked at again only when its last look is older than an hour', async () => {
    const fresh = await card({ sent: 59 })
    const exact = await card({ sent: 60 })
    const old = await card({ sent: 61 })
    expect((await recheck().tick(AT)).checked).toBe(1)
    expect(reads).toEqual([old.id])
    expect(reads).not.toContain(fresh.id)
    expect(reads).not.toContain(exact.id)
  })

  it('FR-LEAD-5: the last look is the later of the card going out and the last read of its page', async () => {
    const readLately = await card({ sent: 300, look: 30 })
    const readLongAgo = await card({ sent: 300, look: 120 })
    const readBeforeCard = await card({ sent: 90, look: 200 })
    await recheck().tick(AT)
    expect(reads.sort()).toEqual([readLongAgo.id, readBeforeCard.id].sort())
    expect(reads).not.toContain(readLately.id)
  })

  it('FR-LEAD-5: a read of the recheck itself counts as a look: the same card waits an hour again', async () => {
    const a = await card({ sent: 300 })
    const job = recheck()
    expect((await job.tick(AT)).checked).toBe(1)
    expect((await job.tick(after(30))).checked).toBe(0)
    expect((await job.tick(after(61))).checked).toBe(1)
    expect(reads).toEqual([a.id, a.id])
  })

  it('FR-LEAD-5: only waiting decision tasks are looked at: not a decided one, not another kind of task', async () => {
    await card({ sent: 300, state: 'resolved' })
    await card({ sent: 300, kind: 'question' })
    const open = await card({ sent: 300 })
    expect((await recheck().tick(AT)).checked).toBe(1)
    expect(reads).toEqual([open.id])
  })

  it('FR-LEAD-5: a task whose card never went out is not looked at; one that kept only its message number is, by its birth', async () => {
    await card({ sent: null, messageId: null, createdMin: 300 })
    const old = await card({ sent: null, createdMin: 300 })
    const fresh = await card({ sent: null, createdMin: 20 })
    await recheck().tick(AT)
    expect(reads).toEqual([old.id])
    expect(reads).not.toContain(fresh.id)
  })

  it('FR-LEAD-5: pages are read from 9:00 to 23:00 Moscow time only', async () => {
    await card({ sent: 5000 })
    const job = recheck()
    for (const t of ['23:00:00', '23:30:00', '03:00:00', '08:59:59']) {
      expect(await job.tick(msk(t, '2026-10-27'))).toEqual({ checked: 0, closed: 0, doubt: false })
    }
    expect(reads).toEqual([])
    expect((await job.tick(msk('22:59:00', '2026-10-27'))).checked).toBe(1)
  })

  it('FR-LEAD-5: the first minute of the day hours reads too', async () => {
    await card({ sent: 5000 })
    expect((await recheck().tick(msk('09:00:00', '2026-10-27'))).checked).toBe(1)
  })
})

describe('what a read page says (FR-LEAD-5)', () => {
  it('FR-LEAD-5: a read is journaled with what the page said, as numbers and flags', async () => {
    const a = await card({ sent: 300 })
    pages[a.id] = { bid_price_rub: 145 }
    await recheck().tick(AT)
    expect((await pageReads(a.id)).at(-1)).toEqual({
      ok: true,
      open: true,
      has_bid: false,
      fee_rub: 145,
      client_info: false,
      error: null,
      via: 'recheck',
    })
  })

  it('FR-LEAD-5: a closed order is closed through the pipeline, an open one is not', async () => {
    const open = await card({ sent: 300 })
    const shut = await card({ sent: 290 })
    pages[shut.id] = { open: false, has_bid: false }
    expect(await recheck().tick(AT)).toEqual({ checked: 2, closed: 1, doubt: false })
    expect(closed).toEqual([shut.taskId])
    expect(closed).not.toContain(open.taskId)
  })

  it('FR-LEAD-5: an order with no word on a bid of ours (has_bid unknown) still reads as closed when it is not open', async () => {
    const a = await card({ sent: 300 })
    pages[a.id] = { open: false, has_bid: null }
    await recheck().tick(AT)
    expect(closed).toEqual([a.taskId])
  })

  it('FR-LEAD-5: an order we bid on is not a closed card: the bid is ours', async () => {
    const a = await card({ sent: 300 })
    pages[a.id] = { open: false, has_bid: true }
    expect(await recheck().tick(AT)).toEqual({ checked: 1, closed: 0, doubt: false })
    expect(closed).toEqual([])
  })

  it('FR-LEAD-5: an answer not read from the page is no read: the pass stops, nothing is closed', async () => {
    const first = await card({ sent: 300 })
    const second = await card({ sent: 200 })
    pages[first.id] = { open: false, from_page: false }
    expect(await recheck().tick(AT)).toEqual({ checked: 0, closed: 0, doubt: false })
    expect(reads).toEqual([first.id])
    expect(closed).toEqual([])
    expect(await pageReads(first.id)).toEqual([
      {
        ok: false,
        open: null,
        has_bid: null,
        fee_rub: null,
        client_info: false,
        error: 'NOT_READ',
        via: 'recheck',
      },
    ])
    expect(await pageReads(second.id)).toEqual([])
  })

  it('FR-LEAD-5: an older node that does not say where the answer comes from is no read either', async () => {
    const a = await card({ sent: 300 })
    pages[a.id] = { open: false, from_page: undefined }
    await recheck().tick(AT)
    expect(closed).toEqual([])
    expect(((await pageReads(a.id)).at(-1) as { error: string }).error).toBe('NOT_READ')
  })

  it('FR-LEAD-5: a failed read is journaled with its class and ends the pass, the earlier reads still count', async () => {
    const first = await card({ sent: 300 })
    const second = await card({ sent: 250 })
    const third = await card({ sent: 200 })
    pages[first.id] = { open: false }
    pages[second.id] = new ProfiError('RATE_LIMITED', 'tab busy')
    expect(await recheck().tick(AT)).toEqual({ checked: 1, closed: 1, doubt: false })
    expect(reads).toEqual([first.id, second.id])
    expect(closed).toEqual([first.taskId])
    expect((await pageReads(second.id)).at(-1)).toMatchObject({
      ok: false,
      error: 'RATE_LIMITED',
      via: 'recheck',
    })
    expect(await pageReads(third.id)).toEqual([])
  })

  it('FR-LEAD-5: an error that is not the node’s is journaled as INTERNAL', async () => {
    const a = await card({ sent: 300 })
    pages[a.id] = new Error('boom')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await recheck().tick(AT)
    } finally {
      log.mockRestore()
    }
    expect(((await pageReads(a.id)).at(-1) as { error: string }).error).toBe('INTERNAL')
  })
})

describe('when many cards look closed at once (FR-LEAD-5)', () => {
  const seed = async (total: number, shut: number) => {
    const out = []
    for (let i = 0; i < total; i++) {
      const c = await card({ sent: 300 - i })
      if (i < shut) pages[c.id] = { open: false }
      out.push(c)
    }
    return out
  }

  it('FR-LEAD-5: fewer than three checked are closed as they are, even all of them', async () => {
    const cards = await seed(2, 2)
    expect(await recheck().tick(AT)).toEqual({ checked: 2, closed: 2, doubt: false })
    expect(closed.sort()).toEqual(cards.map((c) => c.taskId).sort())
    expect(said).toEqual([])
  })

  it('FR-LEAD-5: half of the checked cards or fewer are closed as they are', async () => {
    const cards = await seed(4, 2)
    expect(await recheck().tick(AT)).toEqual({ checked: 4, closed: 2, doubt: false })
    expect(closed.sort()).toEqual([cards[0]?.taskId, cards[1]?.taskId].sort())
    expect(said).toEqual([])
  })

  it('FR-LEAD-5: one of three closed is closed as it is', async () => {
    const cards = await seed(3, 1)
    expect(await recheck().tick(AT)).toEqual({ checked: 3, closed: 1, doubt: false })
    expect(closed).toEqual([cards[0]?.taskId])
  })

  it('FR-LEAD-5: more than half of three or more checked: none is closed, Boris is told', async () => {
    await seed(3, 2)
    expect(await recheck().tick(AT)).toEqual({ checked: 3, closed: 0, doubt: true })
    expect(closed).toEqual([])
    expect(said).toEqual([TEXTS.recheckDoubt(2, 3)])
    expect(await eventCount('lead.recheck_doubt')).toBe(1)
  })

  it('FR-LEAD-5: all four of four closed is a doubt too', async () => {
    await seed(4, 4)
    expect(await recheck().tick(AT)).toEqual({ checked: 4, closed: 0, doubt: true })
    expect(said).toEqual([TEXTS.recheckDoubt(4, 4)])
  })

  it('FR-LEAD-5: Boris is told once in twenty-four hours, then again', async () => {
    await seed(3, 3)
    const job = recheck()
    expect((await job.tick(AT)).doubt).toBe(true)
    // An hour later the cards are looked at again, look closed again, and Boris is not told a second time.
    expect(await job.tick(after(61))).toEqual({ checked: 3, closed: 0, doubt: true })
    expect(await job.tick(after(23 * 60))).toEqual({ checked: 3, closed: 0, doubt: true })
    expect(said).toHaveLength(1)
    expect(await job.tick(after(25 * 60))).toEqual({ checked: 3, closed: 0, doubt: true })
    expect(said).toEqual([TEXTS.recheckDoubt(3, 3), TEXTS.recheckDoubt(3, 3)])
    expect(await eventCount('lead.recheck_doubt')).toBe(2)
    expect(closed).toEqual([])
  })

  it('FR-LEAD-5: a warning Telegram did not take is not written down, so the next pass tries again', async () => {
    await seed(3, 3)
    const job = recheck()
    failSay = true
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(job.tick(AT)).resolves.toEqual({ checked: 3, closed: 0, doubt: true })
    } finally {
      log.mockRestore()
    }
    expect(await eventCount('lead.recheck_doubt')).toBe(0)
    failSay = false
    await job.tick(after(61))
    expect(said).toHaveLength(1)
    expect(await eventCount('lead.recheck_doubt')).toBe(1)
  })
})

describe('a card that cannot be closed (FR-LEAD-5)', () => {
  it('FR-LEAD-5: one card that fails to close does not stop the others, and the failure is logged', async () => {
    const a = await card({ sent: 300 })
    const b = await card({ sent: 290 })
    pages[a.id] = { open: false }
    pages[b.id] = { open: false }
    closeFails = new Set([a.taskId])
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(recheck().tick(AT)).resolves.toMatchObject({ checked: 2, closed: 2 })
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
    expect(closed).toEqual([b.taskId])
  })

  it('FR-LEAD-5: the job runs by itself on its tick, one pass at a time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const a = await card({ sent: 300 })
      pages[a.id] = { open: false }
      let asked = 0
      let free: () => void = () => {}
      const slow = {
        getOrder: async (...args: Parameters<typeof profi.getOrder>) => {
          asked++
          await new Promise<void>((r) => {
            free = r
          })
          return profi.getOrder(...args)
        },
      }
      const job = startCardRecheck({
        db,
        profi: slow,
        notifier,
        close: closeCard,
        now: () => AT,
        tickMs: 1000,
      })
      await vi.advanceTimersByTimeAsync(1000)
      await vi.waitFor(() => expect(asked).toBe(1))
      // Three more ticks go by while the read is still going: no second read is asked.
      await vi.advanceTimersByTimeAsync(3000)
      expect(asked).toBe(1)
      free()
      await vi.waitFor(() => expect(closed).toEqual([a.taskId]))
      expect(reads).toEqual([a.id])
      job.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
