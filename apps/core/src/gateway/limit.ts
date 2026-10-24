const HOUR_MS = 60 * 60_000
/** A reset further out than a weekly limit can be is a misread, not a plan. */
const FAR_MS = 8 * 24 * HOUR_MS
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** The older CLI: "Claude AI usage limit reached|<unix seconds>". */
const UNIX_RESET = /limit reached\|(\d{9,11})/i
/** CLI 2.1: "... · resets 9:40pm (Europe/Moscow)", or "resets Oct 9, 2am (...)" past a day, with the year past New Year. */
const WALL_RESET =
  /resets (?:([a-z]{3}) (\d{1,2}), (?:(\d{4}), )?)?(\d{1,2})(?::(\d{2}))?\s?([ap]m) \(([^)]+)\)/i

/** The wall clock in `zone` at instant `t`, as if that wall clock were UTC. */
function wallMs(t: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(t))
  const v = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'))
}

/** The instant when the wall clock in `zone` shows this date and time. */
function zoned(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const wall = Date.UTC(y, mo, d, h, mi)
  let t = wall - (wallMs(wall, zone) - wall)
  // Near a clock change the first guess sits on the other side of it; one more step settles it.
  t = wall - (wallMs(t, zone) - t)
  return t
}

/**
 * When the subscription limit in a CLI error ends, or null when the text does not say. A time that passed
 * within the last hour is kept: the CLI shows minutes, so the limit may outlive its shown reset a little.
 */
export function parseResetAt(text: string, now: Date): Date | null {
  const n = now.getTime()
  const sane = (t: number) => (t < n - HOUR_MS || t > n + FAR_MS ? null : new Date(t))
  const unix = UNIX_RESET.exec(text)
  if (unix) return sane(Number(unix[1]) * 1000)
  const m = WALL_RESET.exec(text)
  if (!m) return null
  const [, month, day, year, h, mi, half, zone = ''] = m
  const hour = (Number(h) % 12) + (half?.toLowerCase() === 'pm' ? 12 : 0)
  const minute = Number(mi ?? 0)
  try {
    const today = new Date(wallMs(n, zone))
    if (month) {
      const mo = MONTHS.indexOf(month.toLowerCase())
      if (mo < 0) return null
      const y = year ? Number(year) : today.getUTCFullYear()
      return sane(zoned(y, mo, Number(day), hour, minute, zone))
    }
    const [y, mo, d] = [today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()]
    const at = zoned(y, mo, d, hour, minute, zone)
    return sane(at < n - HOUR_MS ? zoned(y, mo, d + 1, hour, minute, zone) : at)
  } catch {
    // An unknown time zone.
    return null
  }
}
