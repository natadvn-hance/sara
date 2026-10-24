import { describe, expect, it } from 'vitest'
import { parseResetAt } from '../../src/gateway/limit'

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
