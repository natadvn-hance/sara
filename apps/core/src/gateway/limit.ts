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
/** A reset days away is still probed now and then: the limit may lift early. */
const LONGEST_CHECK_MS = HOUR_MS

export type LimitChange = 'started' | 'adopted' | 'ended'

export type LimitGuard = {
  active(): boolean
  /** When the limit that holds now ends, as far as a CLI answer said; null without a limit or a known reset. */
  resetAt(): Date | null
  /** A limit answer from a CLI run that started at `runStartedAt` (epoch ms): turns the limit on or updates its reset. */
  hit(resetAt: Date | null, runStartedAt: number): void
  /** The model answered a run that started at `runStartedAt`: the limit, if any, is over and the waiting calls go. */
  answered(runStartedAt: number): void
  /**
   * A limit that held before a restart: on again quietly, and probed at once. `since` (epoch ms) is when it began and
   * `resetAt` the last reset time it gave, as far as the journal has them: the wait is not counted anew.
   */
  adopt(since?: number, resetAt?: Date | null): void
  /**
   * Resolves 'go' when there is no limit or it ends, 'expired' at `deadline` (epoch ms), after the limit has held for
   * `maxWaitMs`, or at once when its known reset comes too late.
   */
  wait(deadline: number): Promise<'go' | 'expired'>
  /** No more probes or changes; a waiting call keeps waiting until the process ends (DBOS runs its step again). */
  stop(): void
}

/**
 * The Claude limit of one model (FR-OPS-3): who waits, when to probe the subscription again. Only a run that started
 * after the limit began can end it, and only one that started after its end can start it again: a slow answer from
 * before never flips the state.
 */
export function createLimitGuard(o: {
  onChange(change: LimitChange): void
  /** One cheap model call; its outcome comes back through hit() or answered(). */
  probe(): Promise<unknown>
  probeEveryMs: number
  maxWaitMs: number
}): LimitGuard {
  let state: { since: number; resetAt: Date | null } | null = null
  let endedAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const waiters = new Map<
    (r: 'go' | 'expired') => void,
    { timer: ReturnType<typeof setTimeout>; until: number }
  >()
  /** A reset time that falls past a waiting call's end ends that wait now. */
  function trim() {
    const resetAt = state?.resetAt?.getTime()
    if (!resetAt) return
    for (const [done, w] of [...waiters]) if (resetAt + AFTER_RESET_MS > w.until) done('expired')
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
    return left > 0 ? Math.min(left, LONGEST_CHECK_MS) : o.probeEveryMs
  }
  async function check() {
    timer = null
    try {
      await o.probe()
    } catch (e) {
      console.error('limit probe failed', e instanceof Error ? e.message : e)
    }
    if (state && !timer) schedule(nextCheckMs())
  }

  return {
    active: () => state !== null,
    resetAt: () => state?.resetAt ?? null,
    hit(resetAt, runStartedAt) {
      if (stopped) return
      if (!state) {
        if (runStartedAt < endedAt) return
        state = { since: Date.now(), resetAt }
        o.onChange('started')
        schedule(nextCheckMs())
      } else if (resetAt && resetAt.getTime() !== state.resetAt?.getTime()) {
        state.resetAt = resetAt
        schedule(nextCheckMs())
        trim()
      } else if (!timer) {
        schedule(nextCheckMs())
      }
    },
    answered(runStartedAt) {
      if (stopped || !state || runStartedAt < state.since) return
      state = null
      endedAt = Date.now()
      if (timer) clearTimeout(timer)
      timer = null
      o.onChange('ended')
      for (const [done] of [...waiters]) done('go')
    },
    adopt(since = Date.now(), resetAt = null) {
      if (stopped || state) return
      state = { since, resetAt }
      o.onChange('adopted')
      schedule(0)
      trim()
    },
    wait(deadline) {
      if (!state) return Promise.resolve('go')
      if (stopped) return new Promise(() => {})
      const until = Math.min(deadline, state.since + o.maxWaitMs)
      const resetAt = state.resetAt?.getTime()
      if (until <= Date.now() || (resetAt && resetAt + AFTER_RESET_MS > until))
        return Promise.resolve('expired')
      return new Promise((resolve) => {
        const done = (r: 'go' | 'expired') => {
          clearTimeout(waiters.get(done)?.timer)
          waiters.delete(done)
          resolve(r)
        }
        const timer = setTimeout(() => done('expired'), until - Date.now())
        timer.unref?.()
        waiters.set(done, { timer, until })
      })
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      for (const w of waiters.values()) clearTimeout(w.timer)
      waiters.clear()
    },
  }
}

/** Boris hears once when the first model meets the limit and once when the last one is free again. */
export function createLimitNotice(
  notify: (text: string) => Promise<unknown>,
): (change: LimitChange) => void {
  let held = 0
  const tell = (text: string) =>
    Promise.resolve()
      .then(() => notify(text))
      .catch((e) => console.error('limit message not sent', e instanceof Error ? e.message : e))
  return (change) => {
    if (change === 'ended') {
      if (held > 0 && --held === 0) void tell(LIMIT_TEXTS.ended)
      return
    }
    if (held++ === 0 && change === 'started') void tell(LIMIT_TEXTS.started)
  }
}
