import { z } from 'zod'
import { DirectionRulesShape } from './direction'

/** What each onboarding role returns (FR-ACC-3): the plain restatement for «Правильно понимаю?» and the structure. */
const understood = z.string().min(1).max(1200)

/** Step 1: what the account does. */
export const OnbAbout = z.object({
  understood,
  about: z.string().min(1),
  services: z.array(z.string()),
  clients: z.array(z.string()),
  budgets: z.array(z.string()),
})
export type OnbAbout = z.infer<typeof OnbAbout>

/** Step 2: what is not taken (stop factors) and what only lowers a lead (red flags). */
export const OnbStops = z.object({
  understood,
  stop_factors: DirectionRulesShape.shape.stop_factors,
  red_flags: DirectionRulesShape.shape.red_flags,
})
export type OnbStops = z.infer<typeof OnbStops>

/** Step 3: the axes, their weights, the threshold and the notes, from Boris's best orders. */
export const OnbIdeal = z.object({
  understood,
  axes: DirectionRulesShape.shape.axes,
  threshold: DirectionRulesShape.shape.threshold,
  notes: DirectionRulesShape.shape.notes,
})
export type OnbIdeal = z.infer<typeof OnbIdeal>

/** The steps that talk to Claude; 4 (calibration) and 8 (turning on) are screens. */
export const ONBOARDING_STEPS = [1, 2, 3, 5, 6, 7] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

/** One step of the draft: Boris's words, Claude's latest reading, the attempts so far and what he confirmed. */
export const StepState = z.object({
  say: z.string(),
  attempts: z.array(z.object({ fix: z.string().nullable(), understood: z.string() })),
  proposal: z.object({ understood: z.string(), data: z.unknown() }).nullable(),
  /** The data of the reading Boris confirmed; null until he does. */
  confirmed: z.unknown(),
  /** Edit mode only: the step stays as the active rules have it. */
  skipped: z.boolean(),
})
export type StepState = z.infer<typeof StepState>

/** The draft is saved on every step (FR-ACC-3); keys are step numbers. */
export const OnboardingDraft = z.object({ steps: z.record(z.string(), StepState) })
export type OnboardingDraft = z.infer<typeof OnboardingDraft>
