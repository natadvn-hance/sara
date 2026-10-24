import { z } from 'zod'

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
} as const

export type SettingKey = keyof typeof SETTINGS
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>
