import { z } from 'zod'

/**
 * Stage 1 «Отсев» of the lead analysis (Boris, 30.10.2026, docs/product/lead-analysis.md): an order is stopped only by
 * facts, the client's profile or the plain sense of the task, before any reading of it. The six stop criteria in the
 * order they are checked: the profile (1-2), the length of the client's own words (3), the sense of the task (4-6).
 */
export const SCREEN_CRITERIA = [
  'new_account',
  'negative_reviews',
  'short_text',
  'direct',
  'wordpress',
  'small_fix',
  'vacancy',
] as const
export const ScreenCriterion = z.enum(SCREEN_CRITERIA)
export type ScreenCriterion = z.infer<typeof ScreenCriterion>

/** The criteria the Sorter judges by sense: the task's core, never a mention in the background. */
export const SENSE_CRITERIA = ['direct', 'wordpress', 'small_fix'] as const
export const SenseCriterion = z.enum(SENSE_CRITERIA)

/** Boris's names of the criteria, as his rules table writes them. */
export const SCREEN_RU: Record<ScreenCriterion, string> = {
  new_account: 'Новый аккаунт',
  negative_reviews: 'Негативные отзывы',
  short_text: 'Короткий текст',
  direct: 'Яндекс Директ',
  wordpress: 'WordPress',
  small_fix: 'Точечные правки',
  vacancy: 'Вакансия',
}

/** One criterion with its basis: a quote of the order or a field of the client's profile. */
export const ScreenMark = z.object({ criterion: ScreenCriterion, basis: z.string() })
export type ScreenMark = z.infer<typeof ScreenMark>

/**
 * What the screen found on one order (stored on the lead; the journal gets the criteria without the quotes).
 * `hits`: the criteria that fired, each with its basis; any one stops the order. `clarify`: core or background was
 * unclear, the order goes on with «уточнить в отклике». `no_data`: the data a criterion needs was missing, so it did
 * not fire. `stops`: the screen was on (a hit stopped the order); false, it only marked it (the shadow).
 */
export const LeadScreen = z.object({
  stops: z.boolean(),
  hits: z.array(ScreenMark),
  clarify: z.array(ScreenMark),
  no_data: z.array(ScreenCriterion),
  /**
   * Boris, 30.10.2026 evening: a text that only looks like a vacancy (one or two signs) is not stopped, it loses
   * points in the score; each sign with its quote. Empty: no such doubt.
   */
  soft: z.array(ScreenMark).default([]),
  /** The points taken off the Scorer's total because of `soft`. */
  penalty: z.number().int().nonnegative().default(0),
  /** The client's own words in the order text, form answers left out; null: no text to count. */
  own_words: z.number().int().nonnegative().nullable(),
  at: z.iso.datetime(),
})
export type LeadScreen = z.infer<typeof LeadScreen>
