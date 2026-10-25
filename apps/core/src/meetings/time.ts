import type { Weekday } from '@sara/shared'

/** Moscow time for meetings, always through Intl, never the server's time zone (design 2, item 6). */

const TZ = 'Europe/Moscow'
const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
})
const WEEKDAY: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
}

export type Msk = { date: string; weekday: Weekday; hhmm: string; hour: number; minute: number }

/** The Moscow date (YYYY-MM-DD), weekday and time of an instant. */
export function msk(at: Date | string): Msk {
  const p = Object.fromEntries(
    parts.formatToParts(typeof at === 'string' ? new Date(at) : at).map((x) => [x.type, x.value]),
  )
  const hour = Number(p.hour)
  const minute = Number(p.minute)
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: WEEKDAY[p.weekday as string] as Weekday,
    hhmm: `${p.hour}:${p.minute}`,
    hour,
    minute,
  }
}

/** The instant of a Moscow date and time ('YYYY-MM-DD', 'HH:MM'). */
export function mskToUtc(date: string, hhmm: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const [h, mi] = hhmm.split(':').map(Number) as [number, number]
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const seen = msk(new Date(guess))
  const [sy, smo, sd] = seen.date.split('-').map(Number) as [number, number, number]
  const offset = Date.UTC(sy, smo - 1, sd, seen.hour, seen.minute) - guess
  return new Date(guess - offset)
}

/** A calendar date plus n days. */
export function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10)
}

/** Whole days from one calendar date to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

export const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  return h * 60 + m
}
