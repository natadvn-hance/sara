import { z } from 'zod'
import { DirectionRulesShape } from './direction'

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

/** The rules proposer's answer (FR-MIND-3): one change in plain words and the whole new rules. */
export const RulesProposalOutput = z.object({
  summary: z.string().max(300),
  why: z.string().max(300),
  rules: DirectionRulesShape,
})
export type RulesProposalOutput = z.infer<typeof RulesProposalOutput>

export const ProbeOutput = z.object({ ok: z.literal(true) })
export type ProbeOutput = z.infer<typeof ProbeOutput>
