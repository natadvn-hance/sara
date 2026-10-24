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

export const LIMIT_TEXTS = {
  started: '⏸️ Лимит Claude кончился, разбор заявок ждёт',
  ended: '▶️ Лимит Claude вернулся',
} as const

/** The CLI shows the reset to the minute: the probe waits out the rest of that minute. */
const AFTER_RESET_MS = 60_000

export type LimitGuard = {
  active(): boolean
  /** A limit answer from the CLI: turns the limit on with one message to Boris, or updates its reset time. */
  hit(resetAt: Date | null): void
  /** The model answered: the limit, if any, is over (one message), and the waiting calls go. */
  answered(): void
  /** A limit that held before a restart: on again without a second message, and probed at once. */
  adopt(): void
  /** Resolves 'go' when there is no limit or it ends, 'expired' at `deadline` (epoch ms) or when it cannot end in time. */
  wait(deadline: number): Promise<'go' | 'expired'>
  stop(): void
}

/** The Claude limit (FR-OPS-3): who waits, when to probe the subscription again, what Boris hears. */
export function createLimitGuard(o: {
  notify(text: string): Promise<unknown>
  /** One cheap model call; its outcome comes back through hit() or answered(). */
  probe(): Promise<unknown>
  probeEveryMs: number
}): LimitGuard {
  let state: { resetAt: Date | null } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const waiters = new Set<(r: 'go' | 'expired') => void>()

  const tell = (text: string) =>
    Promise.resolve()
      .then(() => o.notify(text))
      .catch((e) => console.error('limit message not sent', e instanceof Error ? e.message : e))
  const release = (r: 'go' | 'expired') => {
    for (const done of [...waiters]) done(r)
  }
  function schedule(ms: number) {
    if (timer) clearTimeout(timer)
    timer = null
    if (stopped) return
    timer = setTimeout(() => void check(), Math.max(0, ms))
    timer.unref?.()
  }
  const nextCheckMs = () => {
    const left = state?.resetAt ? state.resetAt.getTime() + AFTER_RESET_MS - Date.now() : 0
    return left > 0 ? left : o.probeEveryMs
  }
  async function check() {
    timer = null
    try {
      await o.probe()
    } catch (e) {
      console.error('limit probe failed', e instanceof Error ? e.message : e)
    }
    if (state && !timer) schedule(o.probeEveryMs)
  }

  return {
    active: () => state !== null,
    hit(resetAt) {
      if (!state) {
        state = { resetAt }
        void tell(LIMIT_TEXTS.started)
        schedule(nextCheckMs())
      } else if (resetAt && resetAt.getTime() !== state.resetAt?.getTime()) {
        state.resetAt = resetAt
        schedule(nextCheckMs())
      } else if (!timer) {
        schedule(nextCheckMs())
      }
    },
    answered() {
      if (!state) return
      state = null
      if (timer) clearTimeout(timer)
      timer = null
      void tell(LIMIT_TEXTS.ended)
      release('go')
    },
    adopt() {
      if (state) return
      state = { resetAt: null }
      schedule(0)
    },
    wait(deadline) {
      if (!state) return Promise.resolve('go')
      const left = deadline - Date.now()
      const resetAt = state.resetAt?.getTime()
      if (stopped || left <= 0 || (resetAt && resetAt + AFTER_RESET_MS > deadline))
        return Promise.resolve('expired')
      return new Promise((resolve) => {
        const done = (r: 'go' | 'expired') => {
          clearTimeout(t)
          waiters.delete(done)
          resolve(r)
        }
        const t = setTimeout(() => done('expired'), left)
        t.unref?.()
        waiters.add(done)
      })
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      release('expired')
    },
  }
}
