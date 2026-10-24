const MOSCOW = 'Europe/Moscow'
const HOUR_MS = 3600_000

const hourOf = new Intl.DateTimeFormat('en-GB', {
  timeZone: MOSCOW,
  hour: 'numeric',
  hourCycle: 'h23',
})

export function moscowHour(now: Date): number {
  return Number(hourOf.formatToParts(now).find((p) => p.type === 'hour')?.value)
}

/** Whether `now` falls in the Moscow hours from `from`:00 to `to`:00, past midnight when from > to. */
export function inMoscowHours(now: Date, h: { from: number; to: number }): boolean {
  const hour = moscowHour(now)
  if (h.from === h.to) return true
  return h.from < h.to ? hour >= h.from && hour < h.to : hour >= h.from || hour < h.to
}

/** When the Moscow hours `now` falls in end (the next `to`:00 Moscow); null when `now` is outside them. */
export function moscowHoursEnd(now: Date, h: { from: number; to: number }): Date | null {
  if (!inMoscowHours(now, h)) return null
  // Moscow has no daylight saving: UTC+3 all year.
  const shifted = new Date(now.getTime() + 3 * HOUR_MS)
  const end = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), h.to) -
      3 * HOUR_MS,
  )
  return end.getTime() > now.getTime() ? end : new Date(end.getTime() + 24 * HOUR_MS)
}
