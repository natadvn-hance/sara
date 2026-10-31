import type { DbOrTx } from '../db/client'
import { getSetting } from '../settings/store'

/**
 * The offer of a call at the end of the series after a bid (Boris, 30.10.2026): «созвониться на полчасика, и
 * предлагать три слота на сегодня или на завтра». The text is approved with the bid and keeps a mark where the times go;
 * the times are picked at the moment it is sent, so they are always ahead. Where the times come from is a `SlotSource`:
 * Boris's working hours now, his calendar later (M6).
 */

/** Where the times go in an approved offer; the code puts them in when it sends. */
export const SLOTS_MARK = '{слоты}'

/**
 * Where free times come from: the times to offer after `now`, by the source's own rules. Today's times first, then those
 * of the next working day; the offer says «или лучше завтра» after today's (Boris, 30.10.2026).
 */
export type SlotSource = { slots(now: Date): Promise<Date[]> }

export type WorkHours = {
  /** Moscow hours: a call starts at `from`:00 at the earliest and ends by `to`:00. */
  hours: { from: number; to: number }
  /** 1 Monday to 7 Sunday. */
  days: number[]
  slotMin: number
  minAheadMin: number
  /** The times Boris likes best, «16:00» and «17:30»; offered first, the nearest others only when none fits. */
  preferred: string[]
  /** Moscow hours of the client night, never offered (past midnight when from > to). */
  night: { from: number; to: number } | null
}

/** Moscow has kept UTC+3 all year since 2014. */
const MSK_MS = 3 * 3600_000
const DAY_MS = 24 * 3600_000
/** The Moscow calendar day of a moment: midnight of it in UTC terms, and its weekday 1 Monday to 7 Sunday. */
function moscowDay(at: Date): { midnight: number; weekday: number } {
  const shifted = at.getTime() + MSK_MS
  const midnight = shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS)
  const weekday = ((new Date(midnight).getUTCDay() + 6) % 7) + 1
  return { midnight, weekday }
}

const inNight = (minute: number, night: WorkHours['night']): boolean => {
  if (!night) return false
  const h = Math.floor(minute / 60)
  return night.from > night.to ? h >= night.from || h < night.to : h >= night.from && h < night.to
}

const minuteOf = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/**
 * The starts offered on one working day (minutes since midnight, Moscow): Boris's preferred times that fit the hours and
 * are not before `earliest`, else the first start of the grid that is. At most two, none when the day has no room.
 */
function dayStarts(w: WorkHours, midnight: number, earliest: number): number[] {
  const last = w.hours.to * 60 - w.slotMin
  const ok = (m: number) =>
    m >= w.hours.from * 60 &&
    m <= last &&
    midnight + m * 60_000 - MSK_MS >= earliest &&
    !inNight(m, w.night)
  const wanted = [...new Set(w.preferred.map(minuteOf).filter((m): m is number => m !== null))]
    .filter(ok)
    .sort((a, b) => a - b)
  if (wanted.length > 0) return wanted.slice(0, 2)
  for (let m = w.hours.from * 60; m <= last; m += w.slotMin) if (ok(m)) return [m]
  return []
}

/**
 * Times for a call by working hours (Boris, 30.10.2026): at least `minAheadMin` after now, within the hours, on working
 * days, not at night; the preferred ones first (16:00 and 17:30). Today's times when any are left, then the next
 * working day's (tomorrow, or Monday after Friday and the weekend), so the offer always has «or tomorrow». Without
 * today's, only tomorrow's.
 */
export function workHoursSlots(now: Date, w: WorkHours): Date[] {
  const earliest = now.getTime() + w.minAheadMin * 60_000
  const today = moscowDay(now)
  const out: Date[] = []
  let days = 0
  for (let d = 0; d < 8 && days < 2; d++) {
    const midnight = today.midnight + d * DAY_MS
    const weekday = ((today.weekday - 1 + d) % 7) + 1
    if (!w.days.includes(weekday)) continue
    const starts = dayStarts(w, midnight, earliest)
    if (starts.length === 0 && d === 0) continue
    // Today counts as a day only when it has times; the next working day always is the «tomorrow».
    out.push(...starts.map((m) => new Date(midnight + m * 60_000 - MSK_MS)))
    days++
    if (d > 0) break
  }
  return out
}

/** Boris's working hours from the settings, read each time: a change in the pult counts from the next offer. */
export function workHoursSource(db: DbOrTx): SlotSource {
  return {
    async slots(now) {
      return workHoursSlots(now, {
        hours: await getSetting(db, 'calls.work_hours'),
        days: await getSetting(db, 'calls.work_days'),
        slotMin: await getSetting(db, 'calls.slot_min'),
        minAheadMin: await getSetting(db, 'calls.min_ahead_min'),
        preferred: await getSetting(db, 'calls.preferred'),
        night: await getSetting(db, 'conv.night'),
      })
    },
  }
}

const WEEKDAY_AT = [
  'в понедельник',
  'во вторник',
  'в среду',
  'в четверг',
  'в пятницу',
  'в субботу',
  'в воскресенье',
]

const hhmm = (t: Date) => {
  const msk = new Date(t.getTime() + MSK_MS)
  return `${msk.getUTCHours()}:${String(msk.getUTCMinutes()).padStart(2, '0')}`
}

/** «сегодня», «завтра» or «в пятницу»: the Moscow day of `t` as seen from `now`. */
function dayWord(t: Date, now: Date): string {
  const a = moscowDay(now)
  const b = moscowDay(t)
  const days = Math.round((b.midnight - a.midnight) / DAY_MS)
  return days === 0 ? 'сегодня' : days === 1 ? 'завтра' : (WEEKDAY_AT[b.weekday - 1] as string)
}

const orJoin = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} или ${xs.at(-1)}`

/**
 * The times as a client reads them: «сегодня в 16:00 или 17:30, или лучше завтра» when today has some (Boris, 30.10.2026),
 * «завтра в 16:00 или 17:30» (or «в понедельник…») when it has none.
 */
export function slotsText(slots: Date[], now: Date): string {
  const days: { word: string; times: string[] }[] = []
  for (const t of slots) {
    const word = dayWord(t, now)
    const day = days.find((x) => x.word === word)
    if (day) day.times.push(hhmm(t))
    else days.push({ word, times: [hhmm(t)] })
  }
  const [first, second] = days
  if (!first) return ''
  if (first.word === 'сегодня' && second)
    return `сегодня в ${orJoin(first.times)}, или лучше ${second.word}`
  return `${first.word} в ${orJoin(first.times)}`
}

/**
 * Offers in Boris's way (30.10.2026: «завершить коротким вопросом», a little more formal, «на 30 минут», no «полчасика»): one or two plain sentences that
 * end with a question, one picked by the order so two orders do not read alike; the times go in at the mark.
 */
const OFFERS = [
  `Предлагаю созвониться на 30 минут и обсудить детали. Вам удобно ${SLOTS_MARK}?`,
  `Предлагаю обсудить всё на созвоне, минут на 30. Вам подойдёт ${SLOTS_MARK}?`,
  `Давайте созвонимся на 30 минут и обсудим детали. Вам удобно ${SLOTS_MARK}?`,
  `Предлагаю встретиться на коротком созвоне, на 30 минут. Вам удобно ${SLOTS_MARK}?`,
]

export function callOfferTemplate(seed: string): string {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return OFFERS[h % OFFERS.length] as string
}

/** Whether a message of the series is the call offer: its times go in when it is sent. */
export const isCallOffer = (text: string) => text.includes(SLOTS_MARK)

/** The offer with its times put in at the mark. */
export const fillCallOffer = (template: string, slots: Date[], now: Date) =>
  template.split(SLOTS_MARK).join(slotsText(slots, now))

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether a text is the one Boris approved: the same text, or for the call offer the same text with only the times
 * put in at the mark (the times are the code's, picked when it is sent).
 */
export function isApprovedText(approved: string, text: string): boolean {
  if (!isCallOffer(approved)) return approved === text
  const pattern = approved.split(SLOTS_MARK).map(escapeRe).join('[^\\n]{1,120}')
  return new RegExp(`^${pattern}$`, 'u').test(text)
}
