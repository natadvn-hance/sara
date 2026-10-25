import { z } from 'zod'

/** Contracts of M6 «Встречи и итоги» (design docs/superpowers/specs/2026-10-25-m6-meetings-design.md, section 6.3). */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'время в виде ЧЧ:ММ')

/** A free window of a day, Moscow time; `from` comes before `to`. */
export const Window = z
  .object({ from: hhmm, to: hhmm })
  .refine((w) => w.from < w.to, { message: 'начало окна раньше конца' })
export type Window = z.infer<typeof Window>

const dayWindows = z
  .array(Window)
  .max(4)
  .refine(
    (ws) => {
      const s = [...ws].sort((a, b) => a.from.localeCompare(b.from))
      return s.every((w, i) => i === 0 || (s[i - 1] as Window).to <= w.from)
    },
    { message: 'окна дня не пересекаются' },
  )

/** Boris's free time for calls (FR-MEET-1), the setting `meet.availability`. */
export const Availability = z.object({
  week: z.object({
    mon: dayWindows,
    tue: dayWindows,
    wed: dayWindows,
    thu: dayWindows,
    fri: dayWindows,
    sat: dayWindows,
    sun: dayWindows,
  }),
  slot_min: z.number().int().min(15).max(120),
  buffer_min: z.number().int().min(0).max(60),
  max_per_day: z.number().int().min(1).max(10),
  notice_h: z.number().int().min(0).max(72),
  horizon_days: z.number().int().min(1).max(21),
  exceptions: z
    .array(z.object({ date: z.iso.date(), windows: dayWindows }))
    .max(60)
    .refine((es) => new Set(es.map((e) => e.date)).size === es.length, {
      message: 'дата исключения встречается один раз',
    }),
})
export type Availability = z.infer<typeof Availability>

const workday = [{ from: '10:00', to: '19:00' }]
/** As old Sara: weekdays 10:00-19:00 Moscow, 30-minute calls, 15 minutes apart, at most 3 a day. */
export const DEFAULT_AVAILABILITY: Availability = {
  week: { mon: workday, tue: workday, wed: workday, thu: workday, fri: workday, sat: [], sun: [] },
  slot_min: 30,
  buffer_min: 15,
  max_per_day: 3,
  notice_h: 3,
  horizon_days: 7,
  exceptions: [],
}

/** Who made the meeting: the call procedure, Boris's mark, or «Позвоню сейчас». */
export const MEETING_KINDS = ['sara', 'boris', 'asap'] as const
export type MeetingKind = (typeof MEETING_KINDS)[number]

export const MEETING_STATES = [
  'offered',
  'confirming',
  'booked',
  'done',
  'no_show',
  'moved',
  'cancelled',
  'withdrawn',
  'expired',
] as const
export type MeetingState = (typeof MEETING_STATES)[number]

/** At most one of these per deal (a partial unique index). */
export const ACTIVE_MEETING_STATES = ['offered', 'confirming', 'booked'] as const

export const CHANNELS = ['phone', 'telemost', 'other'] as const
export type Channel = (typeof CHANNELS)[number]

export const DEAL_OUTCOMES = ['won', 'lost', 'thinking'] as const
export type DealOutcome = (typeof DEAL_OUTCOMES)[number]

export const MEETING_INTENTS = [
  'none',
  'agree',
  'asap',
  'pick',
  'own_time',
  'later',
  'reschedule',
  'cancel',
  'unclear',
] as const

/** The scheduler role's reading of a client's words about a call; the code checks every field (FR-MEET-2). */
export const MeetingReading = z.object({
  intent: z.enum(MEETING_INTENTS),
  slot: z.number().int().min(0).max(2).nullable(),
  own_time: z
    .object({
      date: z.iso.date().nullable(),
      weekday: z.enum(WEEKDAYS).nullable(),
      time: hhmm.nullable(),
      part: z.enum(['morning', 'day', 'evening']).nullable(),
    })
    .nullable(),
  channel: z.enum(CHANNELS).nullable(),
  also_asks: z.boolean(),
  why: z.string().max(200),
})
export type MeetingReading = z.infer<typeof MeetingReading>

/** Three lines for Boris before a call (the briefer role). */
export const MeetingBrief = z.object({
  who: z.string().min(1).max(120),
  need: z.string().min(1).max(160),
  ask: z.string().min(1).max(160),
})
export type MeetingBrief = z.infer<typeof MeetingBrief>

export const MEETING_TEXT_KINDS = [
  'meeting_offer',
  'meeting_confirm',
  'meeting_counter',
  'meeting_ack',
  'meeting_channel',
  'meeting_client_day',
] as const
export type MeetingTextKind = (typeof MEETING_TEXT_KINDS)[number]

const iso = z.iso.datetime()

/** What M4's turn hands the call procedure before the Interlocutor (design 7.1). */
export const ProcedureInput = z.object({
  turn_key: z.string().min(1),
  conversation_id: z.uuid(),
  account_id: z.string(),
  order_id: z.string().nullable(),
  deal_id: z.uuid().nullable(),
  client_name: z.string().nullable(),
  city: z.string().nullable(),
  client_turn: z
    .array(z.object({ platform_message_id: z.string(), text: z.string(), sent_at: iso }))
    .min(1),
  our_last: z.array(z.object({ text: z.string(), sent_at: iso })).max(2),
  owner: z.enum(['sara', 'boris', 'paused']),
  shadow: z.boolean(),
  new_day: z.boolean(),
  now: iso,
})
export type ProcedureInput = z.infer<typeof ProcedureInput>

/** The procedure's answer: not mine, or the move with a template text (ADR-026). */
export const ProcedureResult = z.discriminatedUnion('handled', [
  z.object({ handled: z.literal(false) }),
  z.object({
    handled: z.literal(true),
    move: z.enum(['reply', 'call_boris', 'none']),
    topic: z.literal('call'),
    text: z.string().max(600).nullable(),
    text_kind: z.enum(MEETING_TEXT_KINDS).nullable(),
    urgent: z.boolean(),
    boris_told: z.boolean(),
    reason: z.string().max(200),
    meeting_id: z.uuid().nullable(),
  }),
])
export type ProcedureResult = z.infer<typeof ProcedureResult>

/** What became of a turn that came from the procedure or from startOwnTurn. */
export const TurnOutcome = z.object({
  turn_key: z.string().min(1),
  conversation_id: z.uuid(),
  outcome: z.enum(['sent', 'drafted', 'held', 'cancelled', 'failed']),
  cancel_reason: z.enum(['client_wrote', 'boris_wrote']).nullable(),
  at: iso,
})
export type TurnOutcome = z.infer<typeof TurnOutcome>

/** The meeting line of M4's dossier: an offer the client has, or the agreed meeting. */
export const MeetingContext = z.object({
  state: z.enum(['offered', 'booked']),
  offered: z.array(z.object({ starts_at: iso, label: z.string() })).max(3),
  starts_at: iso.nullable(),
  label: z.string().nullable(),
  channel: z.enum(CHANNELS).nullable(),
  minutes_to_start: z.number().int().nullable(),
})
export type MeetingContext = z.infer<typeof MeetingContext>
