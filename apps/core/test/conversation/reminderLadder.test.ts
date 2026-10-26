import { describe, expect, it } from 'vitest'
import { nextReminder, reminderFallback } from '../../src/conversation/reminders'

const HOUR = 3600_000
const DAY = 24 * HOUR
// 13:00 Moscow on a Tuesday.
const last = '2026-10-20T10:00:00.000Z'
const lastMs = Date.parse(last)
const at = (ms: number) => new Date(lastMs + ms)
const base = { lastOursAt: last, read: false, now: new Date(last) }
const iso = (ms: number) => at(ms).toISOString()

describe('the reminder ladder', () => {
  it('FR-CONV-12: a day after our message, two days after the first, three after the second, and then the silence task', () => {
    expect(nextReminder({ ...base, sent: 0 })).toMatchObject({ at: at(DAY), step: 1 })
    expect(nextReminder({ ...base, sent: 1, prevAt: iso(DAY) })).toMatchObject({
      at: at(3 * DAY),
      step: 2,
    })
    expect(nextReminder({ ...base, sent: 2, prevAt: iso(3 * DAY) })).toMatchObject({
      at: at(6 * DAY),
      step: 3,
    })
    // Three days of silence after the third reminder: the task for Boris, no message to the client.
    expect(nextReminder({ ...base, sent: 3, prevAt: iso(6 * DAY) })).toMatchObject({
      at: at(9 * DAY),
      step: 'dormant',
    })
  })

  it('FR-CONV-12: each wait counts from the step before when it went, not from our message', () => {
    // The first reminder went late, 70 hours after our message: the second is two days after it.
    expect(nextReminder({ ...base, sent: 1, prevAt: iso(70 * HOUR) })?.at).toEqual(
      at(70 * HOUR + 2 * DAY),
    )
    expect(nextReminder({ ...base, sent: 2, prevAt: iso(5 * DAY) })?.at).toEqual(at(8 * DAY))
    expect(nextReminder({ ...base, sent: 3, prevAt: iso(8 * DAY) })?.at).toEqual(at(11 * DAY))
  })

  it('FR-CONV-12: a step that was only skipped counts from its own time, the ladder keeps its length', () => {
    // No time of the step before is known: the ladder's own times are taken (1 + 2 = 3 days, + 3 = 6, + 3 = 9).
    expect(nextReminder({ ...base, sent: 1 })?.at).toEqual(at(3 * DAY))
    expect(nextReminder({ ...base, sent: 2 })?.at).toEqual(at(6 * DAY))
    expect(nextReminder({ ...base, sent: 3 })?.at).toEqual(at(9 * DAY))
  })

  it('FR-CONV-12: the third reminder is the last: after the silence task nothing follows, and there is no way to go on', () => {
    expect(nextReminder({ ...base, sent: 4 })).toBeNull()
    expect(nextReminder({ ...base, sent: 9 })).toBeNull()
    const steps = [0, 1, 2, 3].map((n) => nextReminder({ ...base, sent: n })?.step)
    expect(steps).toEqual([1, 2, 3, 'dormant'])
  })

  it('FR-CONV-12: a client who went to think gets the first reminder after 48 hours, the next waits keep their length', () => {
    expect(nextReminder({ ...base, sent: 0, firstAfterMs: 2 * DAY })).toMatchObject({
      at: at(2 * DAY),
      step: 1,
    })
    const first = iso(2 * DAY)
    expect(nextReminder({ ...base, sent: 1, prevAt: first })?.at).toEqual(at(4 * DAY))
    // Without the sign it is 24 hours as before.
    expect(nextReminder({ ...base, sent: 0 })?.at).toEqual(at(DAY))
    // The ladder's own time for the second step follows the first one's longer wait.
    expect(nextReminder({ ...base, sent: 1, firstAfterMs: 2 * DAY })?.at).toEqual(at(4 * DAY))
  })

  it('FR-CONV-12: the waits can be shortened, for the tests of the process', () => {
    const waitsMs = { second: 10, third: 20, silent: 30 }
    expect(nextReminder({ ...base, sent: 1, prevAt: last, waitsMs })?.at).toEqual(at(10))
    expect(nextReminder({ ...base, sent: 2, prevAt: last, waitsMs })?.at).toEqual(at(20))
    expect(nextReminder({ ...base, sent: 3, prevAt: last, waitsMs })?.at).toEqual(at(30))
  })

  it('FR-CONV-12: the last reminder is friendly, the first two check in', () => {
    expect(nextReminder({ ...base, sent: 0 })?.tone).toBe('check_in')
    expect(nextReminder({ ...base, sent: 1 })?.tone).toBe('check_in')
    expect(nextReminder({ ...base, sent: 2 })?.tone).toBe('friendly')
  })

  it('FR-CONV-12: read and unread clients keep their mark, the timing is the same', () => {
    const read = nextReminder({ ...base, sent: 0, read: true })
    const unread = nextReminder({ ...base, sent: 0, read: false })
    expect(read?.read).toBe(true)
    expect(unread?.read).toBe(false)
    expect(read?.at).toEqual(unread?.at)
  })

  it('FR-CONV-12: a reminder due at night waits until 9:00 Moscow', () => {
    // 23:30 Moscow on Tuesday: +24 h is 23:30 on Wednesday, inside 23:00-9:00.
    const evening = '2026-10-20T20:30:00.000Z'
    const r = nextReminder({
      ...base,
      lastOursAt: evening,
      now: new Date(evening),
      sent: 0,
      quiet: { from: 23, to: 9 },
    })
    expect(r?.at.toISOString()).toBe('2026-10-22T06:00:00.000Z')
    // 03:00 Moscow: also moved, to the same morning.
    const small = '2026-10-20T00:00:00.000Z'
    expect(
      nextReminder({
        ...base,
        lastOursAt: small,
        now: new Date(small),
        sent: 0,
        quiet: { from: 23, to: 9 },
      })?.at.toISOString(),
    ).toBe('2026-10-21T06:00:00.000Z')
    // 9:00 sharp and 22:59 are daytime.
    const nine = '2026-10-20T06:00:00.000Z'
    expect(
      nextReminder({ ...base, lastOursAt: nine, now: new Date(nine), sent: 0 })?.at.toISOString(),
    ).toBe('2026-10-21T06:00:00.000Z')
  })

  it('FR-CONV-12: a reminder that is overdue goes now, or at 9:00 if now is night', () => {
    const now = new Date(lastMs + 2 * DAY + 3 * HOUR)
    expect(nextReminder({ ...base, now, sent: 0 })?.at).toEqual(now)
    // 01:00 Moscow.
    const night = new Date('2026-10-22T22:00:00.000Z')
    expect(nextReminder({ ...base, now: night, sent: 0 })?.at.toISOString()).toBe(
      '2026-10-23T06:00:00.000Z',
    )
  })

  it('FR-CONV-12: the silence task is not moved by the quiet hours, it is a task for Boris', () => {
    const evening = '2026-10-20T20:30:00.000Z'
    const r = nextReminder({
      ...base,
      lastOursAt: evening,
      now: new Date(evening),
      sent: 3,
      quiet: { from: 23, to: 9 },
    })
    expect(r?.step).toBe('dormant')
    // 23:30 Moscow, nine days after our message (1 + 2 + 3 + 3): inside the quiet hours of reminders, but it stays.
    expect(r?.at.toISOString()).toBe('2026-10-29T20:30:00.000Z')
  })

  it('FR-CONV-12: a later reminder inside the quiet hours waits for 9:00 Moscow too', () => {
    // The first went at 22:50 Moscow on Wednesday: two days later is 22:50 on Friday, daytime still.
    const first = '2026-10-21T19:50:00.000Z'
    expect(
      nextReminder({
        ...base,
        sent: 1,
        prevAt: first,
        quiet: { from: 23, to: 9 },
      })?.at.toISOString(),
    ).toBe('2026-10-23T19:50:00.000Z')
    // At 23:10 it is the night: the morning of Saturday.
    const late = '2026-10-21T20:10:00.000Z'
    expect(
      nextReminder({
        ...base,
        sent: 1,
        prevAt: late,
        quiet: { from: 23, to: 9 },
      })?.at.toISOString(),
    ).toBe('2026-10-24T06:00:00.000Z')
  })
})

describe('the ready texts of old Sara', () => {
  it('FR-CONV-12: the ready text greets by the first name, and the friendly one does not ask for a call', () => {
    expect(reminderFallback('Анна Иванова', 'check_in')).toBe(
      'Анна, здравствуйте. Если задача ещё актуальна, давайте обсудим детали: подскажу, с чего начать. Удобно созвониться на 15 минут?',
    )
    expect(reminderFallback(null, 'friendly')).toBe(
      'Здравствуйте. Если вопрос ещё открыт, пишите в любой момент: помогу разобраться, с чего начать. Хорошего дня!',
    )
    expect(reminderFallback('  ', 'check_in').startsWith('Здравствуйте.')).toBe(true)
  })

  it('NFR-UX-1: the ready texts have no long or medium dash', () => {
    for (const tone of ['check_in', 'friendly'] as const)
      for (const variant of [0, 1] as const)
        expect(reminderFallback('Анна', tone, variant)).not.toMatch(/[\u2013\u2014]/)
  })

  it('FR-CONV-12: each ready text has another wording for the second time, without a number or a promise to call', () => {
    for (const tone of ['check_in', 'friendly'] as const) {
      const [a, b] = [0, 1].map((v) => reminderFallback('Анна Иванова', tone, v as 0 | 1))
      expect(a).not.toBe(b)
      expect(b?.startsWith('Анна, здравствуйте.')).toBe(true)
      expect(b).not.toMatch(/\d/)
      expect(b).not.toMatch(/перезвон|наберу|позвоню/i)
    }
  })
})
