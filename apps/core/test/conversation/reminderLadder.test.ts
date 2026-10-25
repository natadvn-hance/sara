import { describe, expect, it } from 'vitest'
import { nextReminder, reminderFallback } from '../../src/conversation/reminders'

const HOUR = 3600_000
const DAY = 24 * HOUR
// 13:00 Moscow on a Tuesday.
const last = '2026-10-20T10:00:00.000Z'
const lastMs = Date.parse(last)
const at = (ms: number) => new Date(lastMs + ms)
const base = { lastOursAt: last, read: false, continued: false, now: new Date(last) }

describe('the reminder ladder', () => {
  it('FR-CONV-12: +24 h, +72 h, dormant at +7 days, then +10 and +30 days after «Напоминать дальше»', () => {
    expect(nextReminder({ ...base, sent: 0 })).toMatchObject({ at: at(DAY), step: 1 })
    expect(nextReminder({ ...base, sent: 1 })).toMatchObject({ at: at(3 * DAY), step: 2 })
    expect(nextReminder({ ...base, sent: 2 })).toMatchObject({ at: at(7 * DAY), step: 'dormant' })
    // Boris said to go on: the next steps count from the dormant day, one after the other.
    const go = { ...base, continued: true }
    expect(nextReminder({ ...go, sent: 2 })).toMatchObject({ at: at(17 * DAY), step: 3 })
    expect(nextReminder({ ...go, sent: 3 })).toMatchObject({ at: at(47 * DAY), step: 4 })
  })

  it('FR-CONV-12: after the last reminder, or without Boris saying to go on, there is nothing more', () => {
    expect(nextReminder({ ...base, continued: true, sent: 4 })).toBeNull()
    expect(nextReminder({ ...base, sent: 3 })).toBeNull()
    expect(nextReminder({ ...base, sent: 9 })).toBeNull()
  })

  it('FR-CONV-12: the last reminder is friendly, the others check in', () => {
    const go = { ...base, continued: true }
    expect(nextReminder({ ...base, sent: 0 })?.tone).toBe('check_in')
    expect(nextReminder({ ...base, sent: 1 })?.tone).toBe('check_in')
    expect(nextReminder({ ...go, sent: 2 })?.tone).toBe('check_in')
    expect(nextReminder({ ...go, sent: 3 })?.tone).toBe('friendly')
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

  it('FR-CONV-12: two reminders never go back to back, a day passes after the one before', () => {
    // The first went late, 70 hours after our message: the second is not at 72 but a day after the first.
    const sentAt = new Date(lastMs + 70 * HOUR).toISOString()
    expect(nextReminder({ ...base, sent: 1, lastSentAt: sentAt })?.at).toEqual(at(94 * HOUR))
    // On time, the ladder's own time is later and stays.
    const onTime = new Date(lastMs + DAY).toISOString()
    expect(nextReminder({ ...base, sent: 1, lastSentAt: onTime })?.at).toEqual(at(3 * DAY))
  })

  it('FR-CONV-12: the dormant day is not moved by the quiet hours, it is a task for Boris', () => {
    const evening = '2026-10-20T20:30:00.000Z'
    const r = nextReminder({
      ...base,
      lastOursAt: evening,
      now: new Date(evening),
      sent: 2,
      quiet: { from: 23, to: 9 },
    })
    expect(r?.step).toBe('dormant')
    expect(r?.at.toISOString()).toBe('2026-10-27T20:30:00.000Z')
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
      expect(reminderFallback('Анна', tone)).not.toMatch(/[\u2013\u2014]/)
  })
})
