import type { Availability, MeetingReading, Weekday, Window } from '@sara/shared'
import { and, gt, inArray, isNotNull, ne, or, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { meeting } from '../db/schema'
import { addDays, daysBetween, minutesOf, msk, mskToUtc } from './time'

/** Boris's free windows and the times Sara offers from them (design 5.1, 5.2). */

export type Busy = { startsAt: string; endsAt: string }
export type Part = 'morning' | 'day' | 'evening'
export type Prefs = { part?: Part; weekday?: Weekday; date?: string }

const STEP_MIN = 30
const MIN = 60_000
/** A pick from an offer is booked if it is at least this far ahead; the notice applies to the client's own time. */
const BOOK_AHEAD_MS = 60 * MIN

function windowsOf(av: Availability, date: string, weekday: Weekday): Window[] {
  return av.exceptions.find((e) => e.date === date)?.windows ?? av.week[weekday]
}

function clashes(av: Availability, start: number, busy: Busy[]): boolean {
  const end = start + av.slot_min * MIN
  const pad = av.buffer_min * MIN
  return busy.some((b) => start < Date.parse(b.endsAt) + pad && Date.parse(b.startsAt) - pad < end)
}

export const partOf = (hhmm: string): Part => {
  const m = minutesOf(hhmm)
  return m < 12 * 60 ? 'morning' : m < 17 * 60 ? 'day' : 'evening'
}

/**
 * Start times a call fits: inside a free window on a 30-minute grid from its start, clear of every meeting with the
 * buffer on both sides, in a day under its maximum, not sooner than the notice, not past the horizon's last day.
 */
export function freeSlots(
  av: Availability,
  busy: Busy[],
  dayCount: Record<string, number>,
  now: Date,
): string[] {
  const earliest = now.getTime() + av.notice_h * 60 * MIN
  const today = msk(now).date
  const out: string[] = []
  for (let k = 0; k <= av.horizon_days; k++) {
    const date = addDays(today, k)
    if ((dayCount[date] ?? 0) >= av.max_per_day) continue
    const weekday = msk(mskToUtc(date, '12:00')).weekday
    for (const w of windowsOf(av, date, weekday)) {
      const from = mskToUtc(date, w.from).getTime()
      const to = mskToUtc(date, w.to).getTime()
      for (let s = from; s + av.slot_min * MIN <= to; s += STEP_MIN * MIN) {
        if (s < earliest || clashes(av, s, busy)) continue
        out.push(new Date(s).toISOString())
      }
    }
  }
  return out
}

/** Up to three times on three different days, by the client's wish first (design 5.2, points 1-3). */
export function pickOffer(
  av: Availability,
  busy: Busy[],
  dayCount: Record<string, number>,
  now: Date,
  prefs: Prefs = {},
): string[] {
  const byDay = new Map<string, string[]>()
  for (const s of freeSlots(av, busy, dayCount, now)) {
    const d = msk(s).date
    byDay.set(d, [...(byDay.get(d) ?? []), s])
  }
  const wished = (d: string) =>
    (prefs.date !== undefined && d === prefs.date) ||
    (prefs.weekday !== undefined && msk(mskToUtc(d, '12:00')).weekday === prefs.weekday)
  const inPart = (s: string) => !prefs.part || partOf(msk(s).hhmm) === prefs.part
  let days = [...byDay.keys()]
  if (prefs.date || prefs.weekday)
    days = [...days.filter(wished), ...days.filter((d) => !wished(d))]
  if (prefs.part && days.some((d) => (byDay.get(d) ?? []).some(inPart)))
    days = days.filter((d) => (byDay.get(d) ?? []).some(inPart))
  if (days.length === 0) return []
  if (days.length === 1) {
    const slots = (byDay.get(days[0] as string) ?? []).filter(inPart)
    const first = slots[0] as string
    const second = slots.find((s) => Date.parse(s) - Date.parse(first) >= 120 * MIN)
    return second ? [first, second] : [first]
  }
  return days.slice(0, 3).map((d, i) => {
    const slots = byDay.get(d) ?? []
    if (prefs.part) return slots.find(inPart) ?? (slots[0] as string)
    if (i === 1) return slots.find((s) => minutesOf(msk(s).hhmm) >= 14 * 60) ?? (slots[0] as string)
    return slots[0] as string
  })
}

const WEEK: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/**
 * The client's own words about time as an instant, or as a wish for a new offer; null when nothing usable. A weekday
 * means the coming one (today only if the time is still more than an hour ahead).
 */
export function resolveOwnTime(
  t: MeetingReading['own_time'],
  now: Date,
): { startsAt: string } | { prefs: Prefs } | null {
  if (!t) return null
  const today = msk(now)
  const ahead = (date: string, hhmm: string) =>
    mskToUtc(date, hhmm).getTime() - now.getTime() > BOOK_AHEAD_MS
  let date = t.date
  if (!date && t.weekday) {
    const shift = (WEEK.indexOf(t.weekday) - WEEK.indexOf(today.weekday) + 7) % 7
    date = addDays(today.date, shift)
    if (shift === 0 && !(t.time && ahead(date, t.time))) date = addDays(today.date, 7)
  }
  if (!date && t.time) date = ahead(today.date, t.time) ? today.date : addDays(today.date, 1)
  if (date && daysBetween(today.date, date) < 0) return null
  if (date && t.time) return { startsAt: mskToUtc(date, t.time).toISOString() }
  const prefs: Prefs = {}
  if (date) prefs.date = date
  else if (t.weekday) prefs.weekday = t.weekday
  if (t.part) prefs.part = t.part
  return Object.keys(prefs).length > 0 ? { prefs } : null
}

/**
 * Whether a time can be booked now: inside a free window of its day, clear of meetings with the buffer, the day under
 * its maximum, at least an hour ahead; with `notice` (the client's own time) also not sooner than the notice.
 */
export function fitsBooking(
  av: Availability,
  startsAt: string,
  busy: Busy[],
  dayCount: Record<string, number>,
  now: Date,
  o: { notice: boolean },
): boolean {
  const s = Date.parse(startsAt)
  if (s - now.getTime() < BOOK_AHEAD_MS) return false
  if (o.notice && s < now.getTime() + av.notice_h * 60 * MIN) return false
  const at = msk(startsAt)
  if ((dayCount[at.date] ?? 0) >= av.max_per_day) return false
  const start = minutesOf(at.hhmm)
  const inWindow = windowsOf(av, at.date, at.weekday).some(
    (w) => start >= minutesOf(w.from) && start + av.slot_min <= minutesOf(w.to),
  )
  return inWindow && !clashes(av, s, busy)
}

/**
 * Meetings that take Boris's time: confirming and booked ones of every account. With soft holds also the times of
 * other deals' open offers, sent ones and those still waiting for M4's pause (younger than 2 hours).
 */
export async function busyFrom(
  db: DbOrTx,
  now: Date,
  o: { softHolds: boolean; exceptDealId?: string },
): Promise<{ busy: Busy[]; dayCount: Record<string, number> }> {
  const since = new Date(now.getTime() - 24 * 60 * MIN).toISOString()
  const rows = await db
    .select({ startsAt: meeting.startsAt, durationMin: meeting.durationMin })
    .from(meeting)
    .where(
      and(
        inArray(meeting.state, ['confirming', 'booked']),
        isNotNull(meeting.startsAt),
        gt(meeting.startsAt, since),
      ),
    )
  const busy: Busy[] = []
  const dayCount: Record<string, number> = {}
  for (const r of rows) {
    const start = r.startsAt as string
    busy.push({
      startsAt: start,
      endsAt: new Date(Date.parse(start) + r.durationMin * MIN).toISOString(),
    })
    const d = msk(start).date
    dayCount[d] = (dayCount[d] ?? 0) + 1
  }
  if (o.softHolds) {
    const fresh = new Date(now.getTime() - 120 * MIN).toISOString()
    const sentSince = new Date(now.getTime() - 72 * 60 * MIN).toISOString()
    const offers = await db
      .select({ offered: meeting.offered, durationMin: meeting.durationMin })
      .from(meeting)
      .where(
        and(
          sql`${meeting.state} = 'offered'`,
          o.exceptDealId ? ne(meeting.dealId, o.exceptDealId) : undefined,
          or(gt(meeting.offerSentAt, sentSince), gt(meeting.createdAt, fresh)),
        ),
      )
    for (const r of offers)
      for (const { starts_at } of (r.offered ?? []) as { starts_at: string }[])
        busy.push({
          startsAt: starts_at,
          endsAt: new Date(Date.parse(starts_at) + r.durationMin * MIN).toISOString(),
        })
  }
  return { busy, dayCount }
}
