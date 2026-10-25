import { z } from 'zod'
import { LOCKED_TOPICS, TOPICS, type Topic } from './conversation'
import { Availability, DEFAULT_AVAILABILITY } from './meeting'

const hours = z.object({
  from: z.number().int().min(0).max(23),
  to: z.number().int().min(0).max(23),
})
const LEVEL = z.enum(['self', 'draft', 'call'])
type Level = z.infer<typeof LEVEL>
const locked = new Set<string>(LOCKED_TOPICS)
const AUTONOMY_DEFAULT = Object.fromEntries(
  TOPICS.map((t) => [t, locked.has(t) ? 'call' : 'draft']),
) as Record<Topic, Level>

export const SETUP_STEPS = ['password', 'telegram', 'claude', 'profi'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

/** C7: every setting with its type and default. */
export const SETTINGS = {
  'outbound.bids': { schema: z.boolean(), default: false },
  'outbound.messages': { schema: z.boolean(), default: false },
  /** Shadow (M1): leads are journaled but not sent as cards, so they do not double v1's summaries. */
  'pipeline.leads': { schema: z.boolean(), default: false },
  'setup.progress': {
    schema: z.object({
      completed: z.array(z.enum(SETUP_STEPS)),
      later: z.array(z.enum(SETUP_STEPS)).default([]),
    }),
    default: { completed: [] as SetupStep[], later: [] as SetupStep[] },
  },
  'reminder.decision_after_min': { schema: z.number().int().positive(), default: 30 },
  /** FR-LEAD-9: bids a Moscow day; old Sara's 10. */
  'money.daily_bids': { schema: z.number().int().positive(), default: 10 },
  /** FR-LEAD-9: rubles a Moscow day for bids; null, no budget (as old Sara). */
  'money.daily_budget_rub': {
    schema: z.number().int().nonnegative().nullable(),
    default: null as number | null,
  },
  /** FR-LEAD-9: the most one bid may cost; null, no ceiling (as old Sara). */
  'money.max_fee_rub': {
    schema: z.number().int().nonnegative().nullable(),
    default: null as number | null,
  },
  /** FR-NOTIF-3: lead cards a Moscow day; the rest wait for the 19:00 summary. */
  'cards.max_per_day': { schema: z.number().int().positive(), default: 10 },
  /**
   * FR-NOTIF-2: Moscow hours when cards come without sound, from `from`:00 to `to`:00 (past midnight when
   * from > to, all day when equal); null, never.
   */
  'cards.quiet_hours': {
    schema: z
      .object({ from: z.number().int().min(0).max(23), to: z.number().int().min(0).max(23) })
      .nullable(),
    default: { from: 23, to: 9 } as { from: number; to: number } | null,
  },
  /** M4: client messages start turns of the conversation; off until the deploy turns it on, as pipeline.leads. */
  'pipeline.conversations': { schema: z.boolean(), default: false },
  /**
   * Shadow (ADR-024): old Sara still writes to clients from this account. While on, the new Sara sends nothing,
   * not even Boris's own text, and a specialist message is not taken for Boris's.
   */
  'conv.v1_writes': { schema: z.boolean(), default: true },
  /** FR-CONV-7: the turn waits this long after the last client message the core heard... */
  'conv.quiet_after_message_s': { schema: z.number().int().positive(), default: 45 },
  /** ...and this long after the last «печатает». */
  'conv.quiet_after_typing_s': { schema: z.number().int().positive(), default: 20 },
  /** FR-CONV-7: never longer than this from the first message of the turn. */
  'conv.max_wait_s': { schema: z.number().int().positive(), default: 600 },
  /** FR-CONV-8: Moscow hours when only urgent replies go to a client. */
  'conv.night': { schema: hours, default: { from: 23, to: 8 } },
  /** FR-CONV-12: Moscow hours without reminders to clients. */
  'conv.reminder_quiet': { schema: hours, default: { from: 23, to: 9 } },
  /** FR-NOTIF-3: draft cards of conversations a Moscow day. */
  'conv.cards_per_day': { schema: z.number().int().positive(), default: 10 },
  /** FR-AUTO-1, FR-AUTO-2: the level of each topic; the locked topics can only call Boris. */
  'conv.autonomy': {
    // A value saved before the topic list changed still reads: missing topics take their default, gone ones drop.
    schema: z.preprocess(
      (v) =>
        v && typeof v === 'object'
          ? Object.fromEntries(
              TOPICS.map((t) => [t, (v as Record<string, unknown>)[t] ?? AUTONOMY_DEFAULT[t]]),
            )
          : v,
      z.record(z.enum(TOPICS), LEVEL).refine((m) => LOCKED_TOPICS.every((t) => m[t] === 'call'), {
        message: 'цена, договор, скидки и NDA всегда у Бориса',
      }),
    ),
    default: AUTONOMY_DEFAULT,
  },
  /** FR-CONV-12: reminders to clients who went quiet. */
  'conv.reminders': { schema: z.boolean(), default: true },
  /** FR-MIND-2: local vectors beside the full-text search, when they proved cheap. */
  'mind.vectors': { schema: z.boolean(), default: false },
  /** FR-MEET-1: Boris's free time for calls, Moscow time. */
  'meet.availability': { schema: Availability, default: DEFAULT_AVAILABILITY },
  /** FR-MEET-2: the call procedure answers clients (in shadow it only drafts). */
  'meet.procedure': { schema: z.boolean(), default: true },
  /** ADR-026: procedure texts go to the client by themselves (self) or as Boris's drafts (draft). */
  'meet.autonomy': { schema: z.enum(['self', 'draft']), default: 'self' as 'self' | 'draft' },
  /** Minutes Sara waits for Boris's «Позвоню сейчас» before she offers the client times. */
  'meet.asap_wait_min': { schema: z.number().int().min(1).max(60), default: 10 },
  /** One message to the client on the meeting day; off until the switch from old Sara. */
  'meet.client_reminder': { schema: z.boolean(), default: false },
  /** FR-ANL: the weekly report, Moscow weekday 1-7 (Monday is 1) and hour; null, none. */
  'analytics.weekly': {
    schema: z
      .object({ weekday: z.number().int().min(1).max(7), hour: z.number().int().min(0).max(23) })
      .nullable(),
    default: { weekday: 1, hour: 10 } as { weekday: number; hour: number } | null,
  },
} as const

export type SettingKey = keyof typeof SETTINGS
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>
