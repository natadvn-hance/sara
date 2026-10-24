import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLimitGuard, parseResetAt } from '../../src/gateway/limit'

// The texts are the CLI's own, from v1's server logs (session and weekly limits, 2026).
const at = (iso: string) => new Date(iso)
const reset = (text: string, now: string) => parseResetAt(text, at(now))?.toISOString() ?? null

describe('Claude limit reset time', () => {
  it('FR-OPS-3: a bare reset time is the next such time in its zone', () => {
    expect(
      reset(
        "You've hit your session limit · resets 9:40pm (Europe/Moscow)",
        '2026-10-01T12:19:00Z',
      ),
    ).toBe('2026-10-01T18:40:00.000Z')
    expect(
      reset("You've hit your weekly limit · resets 2am (Europe/Moscow)", '2026-09-25T10:00:00Z'),
    ).toBe('2026-09-25T23:00:00.000Z')
    expect(reset("You've hit your limit · resets 3pm (UTC)", '2026-10-24T09:00:00Z')).toBe(
      '2026-10-24T15:00:00.000Z',
    )
  })

  it('FR-OPS-3: just after midnight in the zone "12:40am" is minutes away, not a day', () => {
    expect(
      reset(
        "You've hit your session limit · resets 12:40am (Europe/Moscow)",
        '2026-10-01T21:30:00Z',
      ),
    ).toBe('2026-10-01T21:40:00.000Z')
  })

  it('FR-OPS-3: a time passed more than an hour ago is tomorrow, a time just passed is today', () => {
    const text = "You've hit your session limit · resets 9:40pm (Europe/Moscow)"
    expect(reset(text, '2026-10-01T20:00:00Z')).toBe('2026-10-02T18:40:00.000Z')
    // Two minutes after the shown reset the limit may still hold: this is the reset just passing.
    expect(reset(text, '2026-10-01T18:42:00Z')).toBe('2026-10-01T18:40:00.000Z')
  })

  it('FR-OPS-3: a reset more than a day away carries its date', () => {
    expect(
      reset(
        "You've hit your weekly limit · resets Oct 9, 2am (Europe/Moscow)",
        '2026-10-01T12:19:00Z',
      ),
    ).toBe('2026-10-08T23:00:00.000Z')
    expect(
      reset(
        "You've hit your weekly limit · resets Jan 2, 2027, 10:30am (UTC)",
        '2026-12-30T12:00:00Z',
      ),
    ).toBe('2027-01-02T10:30:00.000Z')
  })

  it('FR-OPS-3: the older CLI gives the reset as unix seconds', () => {
    expect(reset('Claude AI usage limit reached|1792857600', '2026-10-24T09:00:00Z')).toBe(
      '2026-10-24T16:00:00.000Z',
    )
  })

  it('FR-OPS-3: no time, an unknown zone or a reset weeks away is unknown', () => {
    expect(reset('Claude AI usage limit reached', '2026-10-24T09:00:00Z')).toBeNull()
    expect(
      reset("You've hit your limit · resets 3pm (Mars/Olympus)", '2026-10-24T09:00:00Z'),
    ).toBeNull()
    expect(
      reset("You've hit your limit · resets Dec 20, 3pm (UTC)", '2026-10-24T09:00:00Z'),
    ).toBeNull()
  })
})

describe('Claude limit state', () => {
  const T0 = new Date('2026-10-24T09:00:00Z')
  const MIN = 60_000
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(o: { notify?: (t: string) => Promise<unknown> } = {}) {
    const sent: string[] = []
    let probes = 0
    const guard = createLimitGuard({
      notify:
        o.notify ??
        (async (t) => {
          sent.push(t)
        }),
      probe: async () => {
        probes++
      },
      probeEveryMs: 10 * MIN,
    })
    return { guard, sent, probes: () => probes }
  }

  it('FR-OPS-3: the first limit sends one message to Boris, its end one more', async () => {
    const { guard, sent } = setup()
    guard.hit(null)
    guard.hit(null)
    expect(guard.active()).toBe(true)
    guard.answered()
    guard.answered()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['⏸️ Лимит Claude кончился, разбор заявок ждёт', '▶️ Лимит Claude вернулся'])
    expect(guard.active()).toBe(false)
    guard.stop()
  })

  it('FR-OPS-3: without a reset time the probe runs every 10 minutes', async () => {
    const { guard, probes } = setup()
    guard.hit(null)
    await vi.advanceTimersByTimeAsync(9 * MIN)
    expect(probes()).toBe(0)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(probes()).toBe(1)
    // The probe ended without an answer from the model: the limit holds, the next probe in 10 minutes.
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(probes()).toBe(2)
    guard.stop()
  })

  it('FR-OPS-3: a repeated limit answer does not put off the next probe', async () => {
    const { guard, probes } = setup()
    guard.hit(null)
    await vi.advanceTimersByTimeAsync(5 * MIN)
    guard.hit(null)
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(probes()).toBe(1)
    guard.stop()
  })

  it('FR-OPS-3: with a reset time the probe runs a minute after it, then every 10 minutes', async () => {
    const { guard, probes } = setup()
    guard.hit(new Date(T0.getTime() + 120 * MIN))
    await vi.advanceTimersByTimeAsync(120 * MIN)
    expect(probes()).toBe(0)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(probes()).toBe(1)
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(probes()).toBe(2)
    guard.stop()
  })

  it('FR-OPS-3: a waiting call goes when the limit ends', async () => {
    const { guard } = setup()
    expect(await guard.wait(Date.now() + 360 * MIN)).toBe('go')
    guard.hit(null)
    const waiting = guard.wait(Date.now() + 360 * MIN)
    await vi.advanceTimersByTimeAsync(30 * MIN)
    guard.answered()
    expect(await waiting).toBe('go')
    guard.stop()
  })

  it('FR-OPS-3: a waiting call expires at its deadline while the limit holds', async () => {
    const { guard } = setup()
    guard.hit(null)
    let got: string | null = null
    void guard.wait(Date.now() + 360 * MIN).then((r) => {
      got = r
    })
    await vi.advanceTimersByTimeAsync(359 * MIN)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(MIN)
    expect(got).toBe('expired')
    guard.stop()
  })

  it('FR-OPS-3: a reset known to come after the deadline expires the wait at once', async () => {
    const { guard } = setup()
    guard.hit(new Date(T0.getTime() + 3 * 24 * 60 * MIN))
    expect(await guard.wait(Date.now() + 360 * MIN)).toBe('expired')
    guard.stop()
  })

  it('FR-OPS-3: a failing notifier does not break the limit state', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { guard } = setup({ notify: () => Promise.reject(new Error('telegram down')) })
    guard.hit(null)
    const waiting = guard.wait(Date.now() + 360 * MIN)
    await vi.advanceTimersByTimeAsync(0)
    expect(guard.active()).toBe(true)
    guard.answered()
    expect(await waiting).toBe('go')
    quiet.mockRestore()
    guard.stop()
  })

  it('FR-OPS-3: a limit known from before a restart sends no start message and is probed at once', async () => {
    const { guard, sent, probes } = setup()
    guard.adopt()
    expect(guard.active()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(probes()).toBe(1)
    guard.answered()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['▶️ Лимит Claude вернулся'])
    guard.stop()
  })

  it('FR-OPS-3: a stopped limit state lets waiting calls go and probes no more', async () => {
    const { guard, probes } = setup()
    guard.hit(null)
    const waiting = guard.wait(Date.now() + 360 * MIN)
    guard.stop()
    expect(await waiting).toBe('expired')
    guard.hit(null)
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(probes()).toBe(0)
  })
})
