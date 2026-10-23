import { z } from 'zod'

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

export const ProbeOutput = z.object({ ok: z.literal(true) })
export type ProbeOutput = z.infer<typeof ProbeOutput>
