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

/**
 * The threshold by the kind of the order (marketing, sites, the rest; see leadKind). A kind that is not set takes
 * `threshold`. Apart from the shape the model answers with: the model never sets it, Boris does, from the settings.
 */
export const KindThresholds = z
  .object({
    marketing: z.number().int().min(0).max(100),
    sites: z.number().int().min(0).max(100),
    other: z.number().int().min(0).max(100),
  })
  .partial()
export type KindThresholds = z.infer<typeof KindThresholds>

/** The rules of an account's direction (FR-ACC-2): what is never taken, what lowers a lead, how it is scored. */
export const DirectionRules = DirectionRulesShape.extend({
  kind_thresholds: KindThresholds.optional(),
})
  .refine((r) => r.axes.reduce((s, a) => s + a.weight, 0) === 100, {
    message: 'axis weights must add up to 100',
  })
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

/** The state of a direction: still being set up, scoring without winning orders, or working (FR-ACC-2). */
export const DirectionState = z.enum(['draft', 'shadow', 'on'])
export type DirectionState = z.infer<typeof DirectionState>

/** The profi.ru bid form takes at most this many characters, the greeting included. */
export const BID_CHARS_MAX = 500

/** How a bid of this direction is built; the greeting is always the program's and always first. */
export const ReplyFormat = z
  .object({
    parts: z
      .array(
        z.object({ id: z.string().regex(/^[a-z_]+$/), title: z.string().min(1), hint: z.string() }),
      )
      .min(1),
    max_chars: z.number().int().min(150).max(BID_CHARS_MAX),
    tone: z.array(z.string().min(1)),
    /** Bids Boris approved as samples (the body only: no greeting, no client name). */
    examples: z.array(z.string().min(1).max(BID_CHARS_MAX)).max(3),
    /** How many cases may go into one bid. */
    max_cases: z.number().int().min(0).max(3),
  })
  .refine((f) => new Set(f.parts.map((p) => p.id)).size === f.parts.length, {
    message: 'part ids must be unique',
  })
export type ReplyFormat = z.infer<typeof ReplyFormat>

/** A case of the direction's library; the model chooses by id, the program puts the link in. */
export const DirectionCase = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  title: z.string().min(1),
  url: z.string().url().startsWith('https://'),
  summary: z.string(),
  tags: z.array(z.string().min(1)),
  show_when: z.string().min(1),
  never_when: z.string().min(1).nullable(),
})
export type DirectionCase = z.infer<typeof DirectionCase>

export const CASES_MAX = 30

/** What a direction holds beside its scoring rules (those are versioned on their own). */
export const DirectionProfileData = z.object({
  speed: z.enum(['normal', 'fast']),
  reply_format: ReplyFormat.nullable(),
  cases: z
    .array(DirectionCase)
    .max(CASES_MAX)
    .refine((c) => new Set(c.map((x) => x.id)).size === c.length, {
      message: 'case ids must be unique',
    }),
})
export type DirectionProfileData = z.infer<typeof DirectionProfileData>
