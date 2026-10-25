import { DEFAULT_AVAILABILITY, newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deal, meeting } from '../../src/db/schema'
import {
  busyFrom,
  fitsBooking,
  freeSlots,
  pickOffer,
  resolveOwnTime,
} from '../../src/meetings/slots'
import { msk } from '../../src/meetings/time'
import { openTestDb, resetDb } from '../helpers/db'

// Sunday 25.10.2026 10:00 Moscow; Monday is 26.10.
const sun = new Date('2026-10-25T07:00:00.000Z')
// Monday 26.10.2026 08:00 Moscow.
const mon = new Date('2026-10-26T05:00:00.000Z')
const iso = (date: string, hhmm: string) => {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  return new Date(Date.UTC(y, mo - 1, d, h - 3, m)).toISOString()
}
const mskOf = (s: string) => `${msk(s).date} ${msk(s).hhmm}`
const only = (mon: { from: string; to: string }[]) => ({
  ...DEFAULT_AVAILABILITY,
  week: { mon, tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
})

describe('free slots', () => {
  it('FR-MEET-1: no slot outside the free windows', () => {
    const s = freeSlots(only([{ from: '10:00', to: '12:00' }]), [], {}, mon)
    expect(s.filter((x) => msk(x).date === '2026-10-26').map((x) => msk(x).hhmm)).toEqual([
      '11:00',
      '11:30',
    ])
    // 10:00 and 10:30 are sooner than the 3-hour notice from 08:00; the next Monday has all four.
    expect(s.filter((x) => msk(x).date === '2026-11-02').map((x) => msk(x).hhmm)).toEqual([
      '10:00',
      '10:30',
      '11:00',
      '11:30',
    ])
  })

  it('FR-MEET-1: no slot beyond the day maximum', () => {
    const s = freeSlots(DEFAULT_AVAILABILITY, [], { '2026-10-28': 3 }, mon)
    expect(s.some((x) => msk(x).date === '2026-10-28')).toBe(false)
    expect(s.some((x) => msk(x).date === '2026-10-29')).toBe(true)
  })

  it('FR-MEET-1: a meeting blocks its slot and the buffer around it', () => {
    const busy = [{ startsAt: iso('2026-10-27', '12:00'), endsAt: iso('2026-10-27', '12:30') }]
    const tue = freeSlots(DEFAULT_AVAILABILITY, busy, {}, mon)
      .filter((x) => msk(x).date === '2026-10-27')
      .map((x) => msk(x).hhmm)
    // 30-minute calls with 15 minutes on both sides: 11:30 ends at 12:00 (inside the buffer), 12:30 starts inside it.
    expect(tue).toContain('11:00')
    expect(tue).not.toContain('11:30')
    expect(tue).not.toContain('12:00')
    expect(tue).not.toContain('12:30')
    expect(tue).toContain('13:00')
  })

  it('FR-MEET-1: nothing sooner than the notice and later than the horizon', () => {
    const s = freeSlots(DEFAULT_AVAILABILITY, [], {}, mon)
    expect(mskOf(s[0] as string)).toBe('2026-10-26 11:00')
    expect(msk(s.at(-1) as string).date).toBe('2026-11-02')
  })

  it('FR-MEET-1: an exception day uses its own windows and an empty one is a day off', () => {
    const av = {
      ...DEFAULT_AVAILABILITY,
      exceptions: [
        { date: '2026-10-27', windows: [] },
        { date: '2026-10-31', windows: [{ from: '12:00', to: '13:00' }] },
      ],
    }
    const s = freeSlots(av, [], {}, mon)
    expect(s.some((x) => msk(x).date === '2026-10-27')).toBe(false)
    expect(s.filter((x) => msk(x).date === '2026-10-31').map((x) => msk(x).hhmm)).toEqual([
      '12:00',
      '12:30',
    ])
  })
})

describe('the offer', () => {
  it('FR-MEET-2: the offer is three times on three different days', () => {
    const o = pickOffer(DEFAULT_AVAILABILITY, [], {}, sun)
    expect(o).toHaveLength(3)
    expect(new Set(o.map((x) => msk(x).date)).size).toBe(3)
  })

  it('FR-MEET-2: without a wish the second day offers the afternoon', () => {
    const o = pickOffer(DEFAULT_AVAILABILITY, [], {}, sun)
    expect(o.map(mskOf)).toEqual(['2026-10-26 10:00', '2026-10-27 14:00', '2026-10-28 10:00'])
  })

  it('FR-MEET-2: a wished weekday comes first', () => {
    const o = pickOffer(DEFAULT_AVAILABILITY, [], {}, sun, { weekday: 'thu' })
    expect(msk(o[0] as string).date).toBe('2026-10-29')
  })

  it('FR-MEET-2: a wished part of the day is kept on every day', () => {
    const o = pickOffer(DEFAULT_AVAILABILITY, [], {}, sun, { part: 'evening' })
    expect(o.map((x) => msk(x).hhmm)).toEqual(['17:00', '17:00', '17:00'])
  })

  it('FR-MEET-2: one free day gives two times at least two hours apart', () => {
    const o = pickOffer(only([{ from: '10:00', to: '19:00' }]), [], {}, sun)
    expect(o.map(mskOf)).toEqual(['2026-10-26 10:00', '2026-10-26 12:00'])
  })

  it('FR-MEET-2: one free day without the wished part still gives real times', () => {
    const o = pickOffer(only([{ from: '10:00', to: '12:00' }]), [], {}, sun, { part: 'evening' })
    expect(o.length).toBeGreaterThan(0)
    for (const t of o) expect(Number.isNaN(Date.parse(t))).toBe(false)
  })

  it('FR-MEET-2: windows saved out of order are offered earliest first', () => {
    const av = only([
      { from: '14:00', to: '19:00' },
      { from: '10:00', to: '13:00' },
    ])
    expect(pickOffer(av, [], {}, sun).map(mskOf)).toEqual(['2026-10-26 10:00', '2026-10-26 12:00'])
  })

  it('FR-MEET-2: nothing free gives an empty offer', () => {
    expect(pickOffer(only([]), [], {}, sun)).toEqual([])
  })
})

describe('the client own time', () => {
  it('FR-MEET-2: "в четверг в 15" resolves to the coming Thursday 15:00 Moscow', () => {
    const r = resolveOwnTime({ date: null, weekday: 'thu', time: '15:00', part: null }, sun)
    expect(r).toEqual({ startsAt: iso('2026-10-29', '15:00') })
  })

  it('FR-MEET-2: the same weekday is today while the time is ahead, else next week', () => {
    expect(resolveOwnTime({ date: null, weekday: 'sun', time: '15:00', part: null }, sun)).toEqual({
      startsAt: iso('2026-10-25', '15:00'),
    })
    // Half an hour ahead is still today: too close to book, so the client gets the two nearest, not another day.
    expect(resolveOwnTime({ date: null, weekday: 'sun', time: '10:30', part: null }, sun)).toEqual({
      startsAt: iso('2026-10-25', '10:30'),
    })
    expect(resolveOwnTime({ date: null, weekday: 'sun', time: '09:30', part: null }, sun)).toEqual({
      startsAt: iso('2026-11-01', '09:30'),
    })
    expect(
      resolveOwnTime({ date: null, weekday: 'sun', time: null, part: 'evening' }, sun),
    ).toEqual({
      prefs: { date: '2026-10-25', part: 'evening' },
    })
    expect(
      resolveOwnTime({ date: null, weekday: 'sun', time: null, part: 'morning' }, sun),
    ).toEqual({
      prefs: { date: '2026-10-25', part: 'morning' },
    })
  })

  it('FR-MEET-2: a bare time is today while ahead, else tomorrow', () => {
    expect(resolveOwnTime({ date: null, weekday: null, time: '15:00', part: null }, sun)).toEqual({
      startsAt: iso('2026-10-25', '15:00'),
    })
    expect(resolveOwnTime({ date: null, weekday: null, time: '09:00', part: null }, sun)).toEqual({
      startsAt: iso('2026-10-26', '09:00'),
    })
  })

  it('FR-MEET-2: a date and a weekday that disagree are nothing', () => {
    // 29.10.2026 is a Thursday.
    expect(
      resolveOwnTime({ date: '2026-10-29', weekday: 'fri', time: '15:00', part: null }, sun),
    ).toBeNull()
    expect(
      resolveOwnTime({ date: '2026-10-29', weekday: 'thu', time: '15:00', part: null }, sun),
    ).toEqual({
      startsAt: iso('2026-10-29', '15:00'),
    })
  })

  it('FR-MEET-2: a vague wish becomes preferences, a past date nothing', () => {
    expect(
      resolveOwnTime({ date: null, weekday: 'fri', time: null, part: 'evening' }, sun),
    ).toEqual({
      prefs: { date: '2026-10-30', part: 'evening' },
    })
    expect(resolveOwnTime({ date: null, weekday: null, time: null, part: 'morning' }, sun)).toEqual(
      {
        prefs: { part: 'morning' },
      },
    )
    expect(
      resolveOwnTime({ date: '2026-10-20', weekday: null, time: '12:00', part: null }, sun),
    ).toBeNull()
    expect(resolveOwnTime(null, sun)).toBeNull()
  })
})

describe('booking check', () => {
  it('FR-MEET-2: an offered time picked the next day is booked by the one hour rule, not the notice', () => {
    // Offered for Monday 11:00; the client answers at 09:30, 1.5 hours ahead (less than the 3-hour notice).
    const at930 = new Date(iso('2026-10-26', '09:30'))
    const s = iso('2026-10-26', '11:00')
    expect(fitsBooking(DEFAULT_AVAILABILITY, s, [], {}, at930, { notice: false })).toBe(true)
    expect(fitsBooking(DEFAULT_AVAILABILITY, s, [], {}, at930, { notice: true })).toBe(false)
    expect(
      fitsBooking(DEFAULT_AVAILABILITY, s, [], {}, new Date(iso('2026-10-26', '10:30')), {
        notice: false,
      }),
    ).toBe(false)
  })

  it('FR-MEET-1: a booking outside the windows, over the day maximum or clashing is refused', () => {
    const s = iso('2026-10-27', '15:10')
    expect(fitsBooking(DEFAULT_AVAILABILITY, s, [], {}, sun, { notice: true })).toBe(true)
    expect(
      fitsBooking(DEFAULT_AVAILABILITY, iso('2026-10-27', '18:45'), [], {}, sun, { notice: true }),
    ).toBe(false)
    expect(
      fitsBooking(DEFAULT_AVAILABILITY, iso('2026-10-25', '15:00'), [], {}, sun, { notice: true }),
    ).toBe(false)
    expect(
      fitsBooking(DEFAULT_AVAILABILITY, s, [], { '2026-10-27': 3 }, sun, { notice: true }),
    ).toBe(false)
    const busy = [{ startsAt: iso('2026-10-27', '15:30'), endsAt: iso('2026-10-27', '16:00') }]
    expect(fitsBooking(DEFAULT_AVAILABILITY, s, busy, {}, sun, { notice: true })).toBe(false)
  })
})

describe('busy time from the database', () => {
  const { db, close } = openTestDb()
  afterAll(close)
  beforeEach(() => resetDb(db))

  async function dealRow() {
    const id = newEventId()
    await db.insert(deal).values({
      id,
      orderId: id,
      origin: 'v1',
      accountId: 'hance-marketing',
      stage: 'talking',
    })
    return id
  }

  it('FR-MEET-2: a sent offer to another client keeps its times out of a new offer but not out of booking', async () => {
    const other = await dealRow()
    const mine = await dealRow()
    const offeredAt = iso('2026-10-26', '10:00')
    await db.insert(meeting).values({
      id: newEventId(),
      dealId: other,
      accountId: 'hance-marketing',
      kind: 'sara',
      state: 'offered',
      durationMin: 30,
      offered: [{ starts_at: offeredAt }],
      offerSentAt: sun.toISOString(),
      createdBy: 'sara',
    })
    const soft = await busyFrom(db, sun, { softHolds: true, exceptDealId: mine })
    expect(pickOffer(DEFAULT_AVAILABILITY, soft.busy, soft.dayCount, sun)[0]).not.toBe(offeredAt)
    const hard = await busyFrom(db, sun, { softHolds: false })
    expect(
      fitsBooking(DEFAULT_AVAILABILITY, offeredAt, hard.busy, hard.dayCount, sun, {
        notice: false,
      }),
    ).toBe(true)
    // The other client's own offer does not hold its own times.
    const own = await busyFrom(db, sun, { softHolds: true, exceptDealId: other })
    expect(own.busy).toHaveLength(0)
  })

  async function offer(
    dealId: string,
    at: string,
    o: { sentAt: string | null; createdAt: string; state?: string },
  ) {
    await db.insert(meeting).values({
      id: newEventId(),
      dealId,
      accountId: 'hance-marketing',
      kind: 'sara',
      state: o.state ?? 'offered',
      durationMin: 30,
      offered: [{ starts_at: at }],
      offerSentAt: o.sentAt,
      createdAt: o.createdAt,
      createdBy: 'sara',
    })
  }

  it('FR-MEET-2: stale offers and other states hold nothing, a fresh unsent one does', async () => {
    const h = (n: number) => new Date(sun.getTime() - n * 3_600_000).toISOString()
    await offer(await dealRow(), iso('2026-10-26', '10:00'), { sentAt: null, createdAt: h(3) })
    await offer(await dealRow(), iso('2026-10-26', '11:00'), { sentAt: h(73), createdAt: h(74) })
    await offer(await dealRow(), iso('2026-10-26', '12:00'), {
      sentAt: h(1),
      createdAt: h(1),
      state: 'expired',
    })
    await offer(await dealRow(), iso('2026-10-26', '13:00'), { sentAt: null, createdAt: h(1) })
    const b = await busyFrom(db, sun, { softHolds: true })
    expect(b.busy.map((x) => mskOf(x.startsAt))).toEqual(['2026-10-26 13:00'])
  })

  it('FR-MEET-1: a confirming meeting is busy, and a meeting that took place still counts in its day', async () => {
    for (const [state, at] of [
      ['confirming', iso('2026-10-27', '10:00')],
      ['done', iso('2026-10-25', '08:00')],
      ['no_show', iso('2026-10-25', '09:00')],
    ] as const)
      await db.insert(meeting).values({
        id: newEventId(),
        dealId: await dealRow(),
        accountId: 'hance-marketing',
        kind: 'boris',
        state,
        startsAt: at,
        durationMin: 30,
        createdBy: 'boris',
      })
    const b = await busyFrom(db, sun, { softHolds: false })
    expect(b.dayCount).toEqual({ '2026-10-27': 1, '2026-10-25': 2 })
    expect(b.busy.some((x) => x.startsAt === iso('2026-10-27', '10:00'))).toBe(true)
  })

  it('FR-MEET-1: booked meetings count in their Moscow day', async () => {
    const d = await dealRow()
    await db.insert(meeting).values({
      id: newEventId(),
      dealId: d,
      accountId: 'hance-marketing',
      kind: 'boris',
      state: 'booked',
      startsAt: iso('2026-10-27', '23:30'),
      durationMin: 30,
      createdBy: 'boris',
    })
    const b = await busyFrom(db, sun, { softHolds: false })
    expect(b.dayCount).toEqual({ '2026-10-27': 1 })
    expect(b.busy).toHaveLength(1)
  })
})
