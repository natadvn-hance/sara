import { z } from 'zod'

/** The shape of the rules without the cross-field checks, for a model's structured answer. */
export const DirectionRulesShape = z.object({
  about: z.string().min(1),
  stop_factors: z.array(
    z.object({
      id: z.string().regex(/^[a-z_]+$/),
      text: z.string().min(1),
      exception: z.string().nullable(),
      examples: z.array(z.string()),
    }),
  ),
  red_flags: z.array(
    z.object({ id: z.string().regex(/^[a-z_]+$/), text: z.string().min(1), soft: z.boolean() }),
  ),
  axes: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z_]+$/),
        title: z.string().min(1),
        weight: z.number().int().positive(),
        how: z.string().min(1),
      }),
    )
    .min(1),
  threshold: z.number().int().min(0).max(100),
  notes: z.array(z.string()),
})

/** The rules of an account's direction (FR-ACC-2): what is never taken, what lowers a lead, how it is scored. */
export const DirectionRules = DirectionRulesShape.refine(
  (r) => r.axes.reduce((s, a) => s + a.weight, 0) === 100,
  {
    message: 'axis weights must add up to 100',
  },
)
  .refine((r) => new Set(r.axes.map((a) => a.id)).size === r.axes.length, {
    message: 'axis ids must be unique',
  })
  .refine((r) => new Set(r.stop_factors.map((s) => s.id)).size === r.stop_factors.length, {
    message: 'stop factor ids must be unique',
  })
export type DirectionRules = z.infer<typeof DirectionRules>

/** The lead's score: each axis 0-100 weighted by the rules, rounded. Every axis must be scored. */
export function weightedScore(rules: DirectionRules, axes: Record<string, number>): number {
  let sum = 0
  for (const a of rules.axes) {
    const v = axes[a.id]
    if (v === undefined) throw new Error(`axis ${a.id} has no score`)
    sum += v * a.weight
  }
  return Math.round(sum / 100)
}
