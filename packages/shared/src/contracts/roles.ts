import { z } from 'zod'
import { DirectionRulesShape } from './direction'
import { SenseCriterion } from './screen'

export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const

export const RoleMeta = z.object({
  name: z.string().min(1),
  version: z.number().int().nonnegative(),
  model: z.enum(MODELS),
  fallbackModel: z.enum(MODELS).optional(),
  priority: z.enum(PRIORITIES),
  timeoutMs: z.number().int().positive(),
})
export type RoleMeta = z.infer<typeof RoleMeta>

export const SorterOutput = z.object({
  verdict: z.enum(['fit', 'maybe', 'reject']),
  reason: z.string().max(200),
  tags: z.array(z.string()).max(8),
  confidence: z.number().min(0).max(1),
  /**
   * The screen's criteria 4-6 (docs/product/lead-analysis.md): only those the task touches, each with a quote of the
   * order. `core`: the task itself is that; `unclear`: core or background cannot be told. Absent in an older answer.
   */
  screen: z
    .array(
      z.object({
        criterion: SenseCriterion,
        verdict: z.enum(['core', 'unclear']),
        quote: z.string().max(300),
      }),
    )
    .max(3)
    .default([]),
})
export type SorterOutput = z.infer<typeof SorterOutput>

/** The Scorer's answer (FR-LEAD-3): the model scores each axis; the total and the decision are the code's. */
export const ScorerOutput = z.object({
  stop_factor: z.string().nullable(),
  red_flags: z.array(z.string()),
  axes: z.array(
    z.object({ id: z.string(), score: z.number().int().min(0).max(100), why: z.string().max(160) }),
  ),
  reason: z.string().max(300),
  confidence: z.number().min(0).max(1),
})
export type ScorerOutput = z.infer<typeof ScorerOutput>

/**
 * The Analyst's draft of a bid (FR-LEAD-6). The fields come in the order the model thinks: first the reading of
 * the order (Boris's hermeneutic method, as old Sara did), then the short разбор (the hidden need, the main risk,
 * the condition to take it), then the body without the greeting (the code adds it) and the «Стоимость услуги».
 */
export const AnalystOutput = z.object({
  reading: z.object({
    /** What the client says explicitly. */
    said: z.string().max(800),
    /** The implicit layers: self-diagnosis, what is really asked, blurred ownership, hands or a strategist. */
    layers: z.string().max(800),
    /** What the client really wants. */
    wants: z.string().max(800),
    /** Who the person likely is. */
    who: z.string().max(800),
    /** Counterarguments and risks. */
    risks: z.string().max(800),
    /** The job the client hires Hance for (JTBD). */
    job: z.string().max(800),
  }),
  hidden_need: z.string().max(300),
  risk: z.string().max(300),
  /** Take it or not, and on what condition. */
  condition: z.string().max(300),
  text: z.string().min(1).max(2000),
  price_rub: z.number().int().nonnegative().nullable(),
  /**
   * The ids of the direction's cases that fit this order (FR-LEAD-6); the program puts in the links and checks the
   * ids against the library. Last in the schema and not required: a direction without cases never sees the field.
   */
  case_ids: z.array(z.string()).max(3).optional(),
  /**
   * The series after the bid (Boris, 29.10.2026): one or two short messages that go into the order's chat a minute or
   * two after the bid, as he wrote himself. The first may show one case of the list by its public link (the program
   * puts the link in under `case_id`), the second is a short human line. Not required: a bid without a series is
   * a bid as before.
   */
  follow_ups: z
    .array(z.object({ text: z.string().min(1).max(300), case_id: z.string().nullable() }))
    .max(2)
    .optional(),
})
export type AnalystOutput = z.infer<typeof AnalystOutput>

/** The rules proposer's answer (FR-MIND-3): one change in plain words and the whole new rules. */
export const RulesProposalOutput = z.object({
  summary: z.string().max(300),
  why: z.string().max(300),
  rules: DirectionRulesShape,
})
export type RulesProposalOutput = z.infer<typeof RulesProposalOutput>

export const ProbeOutput = z.object({ ok: z.literal(true) })
export type ProbeOutput = z.infer<typeof ProbeOutput>
