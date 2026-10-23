import { z } from 'zod'

export const SETUP_STEPS = ['password', 'telegram', 'claude'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

/** C7: every setting with its type and default. */
export const SETTINGS = {
  'outbound.bids': { schema: z.boolean(), default: false },
  'outbound.messages': { schema: z.boolean(), default: false },
  /** Shadow (M1): leads are journaled but not sent as cards, so they do not double v1's summaries. */
  'pipeline.leads': { schema: z.boolean(), default: false },
  'setup.progress': {
    schema: z.object({ completed: z.array(z.enum(SETUP_STEPS)) }),
    default: { completed: [] as SetupStep[] },
  },
  'reminder.decision_after_min': { schema: z.number().int().positive(), default: 30 },
} as const

export type SettingKey = keyof typeof SETTINGS
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>
