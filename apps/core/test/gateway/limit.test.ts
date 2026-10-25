import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLimitGuard, createLimitNotice, parseResetAt } from '../../src/gateway/limit'

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

  function setup() {
    const events: string[] = []
    let probes = 0
    const guard = createLimitGuard({
      onChange: (e) => events.push(e),
      probe: async () => {
        probes++
      },
      probeEveryMs: 10 * MIN,
      maxWaitMs: 360 * MIN,
    })
    return { guard, events, probes: () => probes }
  }

  it('FR-OPS-3: the first limit answer starts the limit once, the first answer after it ends it once', () => {
    const { guard, events } = setup()
    guard.hit(null, Date.now())
    guard.hit(null, Date.now())
    expect(guard.active()).toBe(true)
    vi.advanceTimersByTime(1000)
    guard.answered(Date.now())
    guard.answered(Date.now())
    expect(events).toEqual(['started', 'ended'])
    expect(guard.active()).toBe(false)
    guard.stop()
  })

  it('FR-OPS-3: an answer from a run that started before the limit does not end it', () => {
    const { guard, events } = setup()
    const before = Date.now()
    vi.advanceTimersByTime(1000)
    guard.hit(null, Date.now())
    guard.answered(before)
    expect(guard.active()).toBe(true)
    vi.advanceTimersByTime(1000)
    guard.answered(Date.now())
    expect(events).toEqual(['started', 'ended'])
    guard.stop()
  })

  it('FR-OPS-3: a limit answer from a run that started before the limit ended does not start it again', () => {
    const { guard, events } = setup()
    guard.hit(null, Date.now())
    vi.advanceTimersByTime(1000)
    const during = Date.now()
    vi.advanceTimersByTime(1000)
    guard.answered(Date.now())
    vi.advanceTimersByTime(1000)
    guard.hit(null, during)
    expect(guard.active()).toBe(false)
    expect(events).toEqual(['started', 'ended'])
    guard.stop()
  })

  it('FR-OPS-3: without a reset time the probe runs every 10 minutes', async () => {
    const { guard, probes } = setup()
    guard.hit(null, Date.now())
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
    guard.hit(null, Date.now())
    await vi.advanceTimersByTimeAsync(5 * MIN)
    guard.hit(null, Date.now())
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(probes()).toBe(1)
    guard.stop()
  })

  it('FR-OPS-3: with a reset time the probe runs a minute after it, then every 10 minutes', async () => {
    const { guard, probes } = setup()
    guard.hit(new Date(T0.getTime() + 50 * MIN), Date.now())
    await vi.advanceTimersByTimeAsync(50 * MIN)
    expect(probes()).toBe(0)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(probes()).toBe(1)
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(probes()).toBe(2)
    guard.stop()
  })

  it('FR-OPS-3: a reset days away is still probed every hour, in case the limit lifts early', async () => {
    const { guard, probes } = setup()
    guard.hit(new Date(T0.getTime() + 3 * 24 * 60 * MIN), Date.now())
    await vi.advanceTimersByTimeAsync(59 * MIN)
    expect(probes()).toBe(0)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(probes()).toBe(1)
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(probes()).toBe(2)
    guard.stop()
  })

  it('FR-OPS-3: a waiting call goes when the limit ends', async () => {
    const { guard } = setup()
    expect(await guard.wait(Date.now() + 360 * MIN)).toBe('go')
    guard.hit(null, Date.now())
    const waiting = guard.wait(Date.now() + 360 * MIN)
    await vi.advanceTimersByTimeAsync(30 * MIN)
    guard.answered(Date.now())
    expect(await waiting).toBe('go')
    guard.stop()
  })

  it('FR-OPS-3: a waiting call expires at its deadline while the limit holds', async () => {
    const { guard } = setup()
    guard.hit(null, Date.now())
    let got: string | null = null
    void guard.wait(Date.now() + 120 * MIN).then((r) => {
      got = r
    })
    await vi.advanceTimersByTimeAsync(119 * MIN)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(MIN)
    expect(got).toBe('expired')
    guard.stop()
  })

  it('FR-OPS-3: after 6 hours of limit a call waits no more, whatever its own deadline', async () => {
    const { guard } = setup()
    guard.hit(null, Date.now())
    await vi.advanceTimersByTimeAsync(300 * MIN)
    let got: string | null = null
    void guard.wait(Date.now() + 360 * MIN).then((r) => {
      got = r
    })
    await vi.advanceTimersByTimeAsync(59 * MIN)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(MIN)
    expect(got).toBe('expired')
    expect(await guard.wait(Date.now() + 360 * MIN)).toBe('expired')
    guard.stop()
  })

  it('FR-OPS-3: a reset known to come after the deadline expires the wait at once', async () => {
    const { guard } = setup()
    guard.hit(new Date(T0.getTime() + 3 * 24 * 60 * MIN), Date.now())
    expect(await guard.wait(Date.now() + 360 * MIN)).toBe('expired')
    guard.stop()
  })

  it('FR-OPS-3: a limit known from before a restart is adopted quietly and probed at once', async () => {
    const { guard, events, probes } = setup()
    guard.adopt()
    expect(guard.active()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(probes()).toBe(1)
    guard.answered(Date.now())
    expect(events).toEqual(['adopted', 'ended'])
    guard.stop()
  })

  it('FR-OPS-3: a limit adopted with its start counts the 6 hours from that start, not from the restart', async () => {
    const { guard } = setup()
    guard.adopt(T0.getTime() - 300 * MIN)
    let got: string | null = null
    void guard.wait(Date.now() + 360 * MIN).then((r) => {
      got = r
    })
    await vi.advanceTimersByTimeAsync(59 * MIN)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(MIN)
    expect(got).toBe('expired')
    guard.stop()
  })

  it('FR-OPS-3: a limit that began more than 6 hours before the restart is not waited for at all', async () => {
    const { guard } = setup()
    guard.adopt(T0.getTime() - 400 * MIN)
    expect(await guard.wait(Date.now() + 360 * MIN)).toBe('expired')
    guard.stop()
  })

  it('FR-OPS-3: a limit adopted with its reset time knows a reset past the deadline', async () => {
    const { guard } = setup()
    guard.adopt(T0.getTime() - MIN, new Date(T0.getTime() + 3 * 24 * 60 * MIN))
    expect(await guard.wait(Date.now() + 360 * MIN)).toBe('expired')
    guard.stop()
  })

  it('FR-OPS-3: a limit adopted with a near reset time keeps a call waiting for it', async () => {
    const { guard } = setup()
    guard.adopt(T0.getTime() - MIN, new Date(T0.getTime() + 30 * MIN))
    const waiting = guard.wait(Date.now() + 360 * MIN)
    await vi.advanceTimersByTimeAsync(31 * MIN)
    guard.answered(Date.now())
    expect(await waiting).toBe('go')
    guard.stop()
  })

  it('FR-OPS-3: a reset time learned while a call waits shortens that wait when it falls past its deadline', async () => {
    const { guard } = setup()
    guard.hit(null, Date.now())
    let got: string | null = null
    void guard.wait(Date.now() + 120 * MIN).then((r) => {
      got = r
    })
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(got).toBeNull()
    guard.hit(new Date(T0.getTime() + 3 * 24 * 60 * MIN), Date.now())
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toBe('expired')
    guard.stop()
  })

  it('FR-OPS-3: a reset time learned while a call waits leaves it waiting when the reset comes in time', async () => {
    const { guard } = setup()
    guard.hit(null, Date.now())
    let got: string | null = null
    void guard.wait(Date.now() + 120 * MIN).then((r) => {
      got = r
    })
    guard.hit(new Date(T0.getTime() + 60 * MIN), Date.now())
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(got).toBeNull()
    guard.stop()
  })

  it('FR-OPS-3: a stopped limit state keeps waiting calls waiting, tells nothing and probes no more', async () => {
    const { guard, events, probes } = setup()
    guard.hit(null, Date.now())
    let got: string | null = null
    void guard.wait(Date.now() + 360 * MIN).then((r) => {
      got = r
    })
    guard.stop()
    guard.answered(Date.now() + 1)
    guard.hit(null, Date.now() + 1)
    await vi.advanceTimersByTimeAsync(7 * 60 * MIN)
    // A process about to exit leaves a waiting DBOS step unfinished: it is run again after the restart.
    expect(got).toBeNull()
    expect(events).toEqual(['started'])
    expect(probes()).toBe(0)
  })
})

describe('Claude limit messages to Boris', () => {
  it('FR-OPS-3: one message when the first model meets the limit, one when the last is free', async () => {
    const sent: string[] = []
    const notice = createLimitNotice(async (t) => {
      sent.push(t)
    })
    notice('started')
    notice('started')
    notice('ended')
    await new Promise((r) => setImmediate(r))
    expect(sent).toEqual(['⏸️ Лимит Claude кончился, разбор заявок ждёт'])
    notice('ended')
    await new Promise((r) => setImmediate(r))
    expect(sent).toEqual(['⏸️ Лимит Claude кончился, разбор заявок ждёт', '▶️ Лимит Claude вернулся'])
  })

  it('FR-OPS-3: a limit adopted after a restart sends no start message, its end does', async () => {
    const sent: string[] = []
    const notice = createLimitNotice(async (t) => {
      sent.push(t)
    })
    notice('adopted')
    notice('ended')
    await new Promise((r) => setImmediate(r))
    expect(sent).toEqual(['▶️ Лимит Claude вернулся'])
  })

  it('FR-OPS-3: a failing notifier breaks nothing', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notice = createLimitNotice(() => Promise.reject(new Error('telegram down')))
    notice('started')
    notice('ended')
    await new Promise((r) => setImmediate(r))
    expect(quiet).toHaveBeenCalledTimes(2)
    quiet.mockRestore()
  })
})
