import { z } from 'zod'
import { LOCKED_TOPICS, TOPICS, type Topic } from './conversation'

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
  /** FR-LEAD-7: minutes after which a card that never went out is delivered once; no card is sent again (Boris, 26.10.2026). */
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
  /**
   * M4: client messages start turns of the conversation; off until the deploy turns it on, as pipeline.leads. Off, no
   * reminder starts either, and the waiting ones skip their steps (they go on when it is turned on again).
   */
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
  /**
   * FR-CONV-12: reminders to clients who went quiet. Off: nothing new starts, and a reminder that falls due meanwhile
   * is skipped, not sent later; the processes that wait go on when it is turned on again.
   */
  'conv.reminders': { schema: z.boolean(), default: true },
  /** FR-MIND-2: local vectors beside the full-text search, when they proved cheap. */
  'mind.vectors': { schema: z.boolean(), default: false },
  /** M5: the school's jobs and lesson batches; off until the deploy turns it on, as pipeline.*. */
  'school.on': { schema: z.boolean(), default: false },
  /** NFR-COST-2: Moscow hours of the night school. */
  'school.night': {
    schema: hours.refine((h) => h.from !== h.to, { message: 'ночь не может быть сутками' }),
    default: { from: 1, to: 7 },
  },
  /** NFR-COST-2: units a night (haiku 1, sonnet 4, opus 20). */
  'school.night_units': { schema: z.number().int().positive(), default: 400 },
  /** NFR-COST-2: more units on the weekly exam night, for its own jobs only. */
  'school.weekly_units': { schema: z.number().int().nonnegative(), default: 700 },
  /** FR-TRAIN-8, FR-SPEECH-4: the day the weekly exam's night ends on (0 Sunday, the night from Saturday). */
  'school.weekly_day': { schema: z.number().int().min(0).max(6), default: 0 },
  /** FR-TRAIN-9: made-up dialogs a night, five a call. */
  'school.generator_dialogs': { schema: z.number().int().positive(), default: 50 },
  /** FR-TRAIN-6: lessons in one Telegram batch. */
  'school.lesson_batch': { schema: z.number().int().positive(), default: 5 },
  /** FR-TRAIN-6: lesson batches a Moscow day. */
  'school.batches_per_day': { schema: z.number().int().positive(), default: 2 },
  /** FR-TRAIN-7: the teacher skips a night while this many cards wait for Boris. */
  'school.cards_waiting_max': { schema: z.number().int().positive(), default: 15 },
  /** FR-NOTIF-3: messages the school sends of its own accord a Moscow day; the rest go to the evening summary. */
  'school.messages_per_day': { schema: z.number().int().positive(), default: 3 },
  /** FR-TRAIN-8: the exam judge agreed with Boris on 20 golden items; set by the code. */
  'school.judge_trusted': { schema: z.boolean(), default: false },
  /** FR-AUTO-3: approvals in a row before Sara proposes a topic. */
  'auto.approvals_to_promote': { schema: z.number().int().positive(), default: 10 },
  /** FR-AUTO-3: ratings of the topic in the trainer within 14 days... */
  'auto.trainer_checks': { schema: z.number().int().positive(), default: 5 },
  /** ...and how many of them «так и отправила бы». */
  'auto.trainer_good': { schema: z.number().int().positive(), default: 4 },
  /** FR-AUTO-4: below this similarity (%) Boris's edit is substantial. */
  'auto.substantial_below': { schema: z.number().int().min(1).max(100), default: 70 },
  /** FR-AUTO-2: after the switch a reply wholly from a confirmed understanding goes by itself. */
  'auto.from_understanding': { schema: z.boolean(), default: true },
} as const

export type SettingKey = keyof typeof SETTINGS
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>
