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

/** How many times an offer gives. */
export const SLOTS_OFFERED = 3

/** Where free times come from: the starts of up to `count` free times after `now`, by the source's own rules. */
export type SlotSource = { slots(now: Date, count: number): Promise<Date[]> }

export type WorkHours = {
  /** Moscow hours: a call starts at `from`:00 at the earliest and ends by `to`:00. */
  hours: { from: number; to: number }
  /** 1 Monday to 7 Sunday. */
  days: number[]
  slotMin: number
  minAheadMin: number
  /** Moscow hours of the client night, never offered (past midnight when from > to). */
  night: { from: number; to: number } | null
}

/** Moscow has kept UTC+3 all year since 2014. */
const MSK_MS = 3 * 3600_000
const DAY_MS = 24 * 3600_000
/** The times offered on one day are at least an hour apart, so the client has a real choice. */
const GAP_MIN = 60

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

/** Up to `count` of the day's starts spread over it, an hour apart at least: the first, the last and between. */
function spread(starts: number[], count: number, gapMs: number): number[] {
  if (starts.length === 0 || count <= 0) return []
  if (count === 1) return [starts[0] as number]
  const picked: number[] = []
  for (let j = 0; j < count; j++) {
    const s = starts[Math.round((j * (starts.length - 1)) / (count - 1))] as number
    const last = picked.at(-1)
    if (last === undefined || s - last >= gapMs) picked.push(s)
  }
  return picked
}

/**
 * Times for a call by working hours: only ahead by `minAheadMin` at least, on working days, within the hours and not at
 * night, every `slotMin` minutes, an hour apart. Today when it still has `count` such times, else the next working day
 * (tomorrow, or Monday after a weekend), never a mix. Empty when a week has none.
 */
export function workHoursSlots(now: Date, w: WorkHours, count = SLOTS_OFFERED): Date[] {
  const earliest = now.getTime() + w.minAheadMin * 60_000
  const today = moscowDay(now)
  let fallback: number[] = []
  for (let d = 0; d < 8; d++) {
    const midnight = today.midnight + d * DAY_MS
    const weekday = ((today.weekday - 1 + d) % 7) + 1
    if (!w.days.includes(weekday)) continue
    const starts: number[] = []
    for (let m = w.hours.from * 60; m + w.slotMin <= w.hours.to * 60; m += w.slotMin) {
      const at = midnight + m * 60_000 - MSK_MS
      if (at >= earliest && !inNight(m, w.night)) starts.push(at)
    }
    const picked = spread(starts, count, GAP_MIN * 60_000)
    if (picked.length === count) return picked.map((t) => new Date(t))
    if (fallback.length === 0 && d > 0) fallback = picked
  }
  return fallback.map((t) => new Date(t))
}

/** Boris's working hours from the settings, read each time: a change in the pult counts from the next offer. */
export function workHoursSource(db: DbOrTx): SlotSource {
  return {
    async slots(now, count) {
      return workHoursSlots(
        now,
        {
          hours: await getSetting(db, 'calls.work_hours'),
          days: await getSetting(db, 'calls.work_days'),
          slotMin: await getSetting(db, 'calls.slot_min'),
          minAheadMin: await getSetting(db, 'calls.min_ahead_min'),
          night: await getSetting(db, 'conv.night'),
        },
        count,
      )
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

/** The times as a client reads them: «сегодня в 12:00, 14:30 или 18:00», «сегодня в 18:00 или завтра в 11:00». */
export function slotsText(slots: Date[], now: Date): string {
  const days: { word: string; times: string[] }[] = []
  for (const t of slots) {
    const word = dayWord(t, now)
    const day = days.find((x) => x.word === word)
    if (day) day.times.push(hhmm(t))
    else days.push({ word, times: [hhmm(t)] })
  }
  if (days.length === 1) {
    const [only] = days
    return only ? `${only.word} в ${orJoin(only.times)}` : ''
  }
  return orJoin(days.map((x) => `${x.word} в ${x.times.join(', ')}`))
}

/**
 * Offers in Boris's way (30.10.2026: «завершить коротким вопросом, разговорным языком»): one or two plain sentences that
 * end with a question, one picked by the order so two orders do not read alike; the times go in at the mark.
 */
const OFFERS = [
  `Может, созвонимся на полчасика и обсудим всё голосом? Могу ${SLOTS_MARK}, как вам удобнее?`,
  `Давайте лучше встретимся на созвоне и всё обсудим лично? Я свободен ${SLOTS_MARK}, что вам удобно?`,
  `Может, выйдем на созвон на полчаса и разберём всё голосом? Могу ${SLOTS_MARK}, как вам?`,
  `Предлагаю просто созвониться и обсудить всё лично, минут на тридцать. Удобно ${SLOTS_MARK}?`,
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
