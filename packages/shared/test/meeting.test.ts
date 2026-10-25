import { describe, expect, it } from 'vitest'
import {
  Availability,
  DEFAULT_AVAILABILITY,
  EVENT_TYPES,
  formatCallback,
  MeetingReading,
  ProcedureResult,
  SETTINGS,
  TASK_ACTIONS,
  TurnOutcome,
} from '../src/index'

const week = (mon: { from: string; to: string }[]) => ({
  ...DEFAULT_AVAILABILITY,
  week: { ...DEFAULT_AVAILABILITY.week, mon },
})

describe('meeting contracts', () => {
  it('FR-MEET-1: windows of a day must not overlap and from comes before to', () => {
    expect(Availability.safeParse(week([{ from: '10:00', to: '12:00' }])).success).toBe(true)
    expect(Availability.safeParse(week([{ from: '12:00', to: '10:00' }])).success).toBe(false)
    expect(Availability.safeParse(week([{ from: '10:00', to: '10:00' }])).success).toBe(false)
    expect(
      Availability.safeParse(
        week([
          { from: '10:00', to: '13:00' },
          { from: '12:30', to: '15:00' },
        ]),
      ).success,
    ).toBe(false)
    expect(
      Availability.safeParse(
        week([
          { from: '10:00', to: '12:00' },
          { from: '12:00', to: '15:00' },
        ]),
      ).success,
    ).toBe(true)
    expect(Availability.safeParse(week([{ from: '9:00', to: '12:00' }])).success).toBe(false)
  })

  it('FR-MEET-1: an exception date appears once', () => {
    const day = { date: '2026-10-30', windows: [] }
    expect(Availability.safeParse({ ...DEFAULT_AVAILABILITY, exceptions: [day] }).success).toBe(
      true,
    )
    expect(
      Availability.safeParse({ ...DEFAULT_AVAILABILITY, exceptions: [day, day] }).success,
    ).toBe(false)
  })

  it('FR-MEET-1: the default free time is weekdays 10:00-19:00, 30 minutes, 3 a day', () => {
    const d = SETTINGS['meet.availability'].default
    for (const w of ['mon', 'tue', 'wed', 'thu', 'fri'] as const)
      expect(d.week[w]).toEqual([{ from: '10:00', to: '19:00' }])
    expect(d.week.sat).toEqual([])
    expect(d.week.sun).toEqual([])
    expect(d).toMatchObject({
      slot_min: 30,
      buffer_min: 15,
      max_per_day: 3,
      notice_h: 3,
      horizon_days: 7,
      exceptions: [],
    })
    expect(SETTINGS['meet.availability'].schema.safeParse(d).success).toBe(true)
    expect(SETTINGS['meet.autonomy'].default).toBe('self')
    expect(SETTINGS['meet.client_reminder'].default).toBe(false)
    expect(SETTINGS['meet.asap_wait_min'].default).toBe(10)
    expect(SETTINGS['analytics.weekly'].default).toEqual({ weekday: 1, hour: 10 })
  })

  it('FR-MEET-2: a reading with a slot outside 0..2 is refused', () => {
    const r = {
      intent: 'pick',
      slot: 1,
      own_time: null,
      channel: null,
      also_asks: false,
      why: 'выбрал второй вариант',
    }
    expect(MeetingReading.safeParse(r).success).toBe(true)
    expect(MeetingReading.safeParse({ ...r, slot: 3 }).success).toBe(false)
    expect(MeetingReading.safeParse({ ...r, slot: -1 }).success).toBe(false)
  })

  it('FR-MEET-2: a handled procedure result carries its move, topic call and text kind', () => {
    expect(ProcedureResult.safeParse({ handled: false }).success).toBe(true)
    const ok = {
      handled: true,
      move: 'reply',
      topic: 'call',
      text: 'Давайте созвонимся.',
      text_kind: 'meeting_offer',
      urgent: false,
      boris_told: false,
      reason: 'клиент согласился',
      meeting_id: null,
    }
    expect(ProcedureResult.safeParse(ok).success).toBe(true)
    expect(ProcedureResult.safeParse({ ...ok, topic: 'price' }).success).toBe(false)
    const { move: _m, ...noMove } = ok
    expect(ProcedureResult.safeParse(noMove).success).toBe(false)
    expect(
      TurnOutcome.safeParse({
        turn_key: 'conv-turn:x:1',
        conversation_id: '0b6f7c1e-7a35-4f4b-9b1a-2f1d3c4b5a69',
        outcome: 'cancelled',
        cancel_reason: 'client_wrote',
        at: '2026-10-25T10:00:00.000Z',
      }).success,
    ).toBe(true)
  })

  it('FR-NOTIF-1: every new button action fits 64 bytes of callback data', () => {
    const id = '0b6f7c1e-7a35-4f4b-9b1a-2f1d3c4b5a69'
    const added = [
      'meet',
      'held',
      'noshow',
      'moved',
      'won',
      'thinking',
      'lost',
      'later',
      'offer',
      'callnow',
      'cancel',
      'fix',
      'agreed',
    ] as const
    for (const a of added) {
      expect(TASK_ACTIONS).toContain(a)
      expect(Buffer.byteLength(formatCallback(id, a))).toBeLessThanOrEqual(64)
    }
  })

  it('FR-MEET-3: meeting events are in the journal list', () => {
    for (const t of [
      'meeting.call_asked',
      'meeting.offered',
      'meeting.confirming',
      'meeting.unconfirmed',
      'meeting.withdrawn',
      'meeting.expired',
      'meeting.booked',
      'meeting.announced',
      'meeting.moved',
      'meeting.cancelled',
      'meeting.reminded',
      'meeting.held',
      'meeting.no_show',
      'deal.outcome_set',
      'deal.amount_set',
      'analytics.report_sent',
    ])
      expect(EVENT_TYPES).toContain(t)
  })
})
