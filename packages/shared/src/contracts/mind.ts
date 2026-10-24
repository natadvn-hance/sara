import { z } from 'zod'
import { CONV_STAGES, TONES, TOPICS } from './conversation'

export const MIND_TYPES = ['knowledge', 'understanding', 'speech', 'judgment', 'example'] as const
export type MindType = (typeof MIND_TYPES)[number]

/** The letter a record id starts with, by its type (M4 design 5.2); checked by `pnpm mind:check`. */
export const MIND_ID_PREFIX: Record<MindType, string> = {
  knowledge: 'k-',
  understanding: 'u-',
  speech: 's-',
  judgment: 'j-',
  example: 'e-',
}

/** C6: fields at the top of every mind record. Version 2 adds optional fields, so version 1 records still parse. */
export const MindFrontmatter = z.object({
  id: z.string().min(1),
  type: z.enum(MIND_TYPES),
  scope: z.string().min(1),
  status: z.enum(['confirmed', 'proposal', 'outdated']),
  version: z.number().int().positive(),
  sources: z.array(z.string().min(1)).min(1),
  valid_from: z.iso.date(),
  valid_to: z.iso.date().nullable(),
  title: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  topic: z.enum(TOPICS).optional(),
  tones: z.array(z.enum(TONES)).optional(),
  stages: z.array(z.enum(CONV_STAGES)).optional(),
  examples: z.array(z.string().min(1)).optional(),
})
export type MindFrontmatter = z.infer<typeof MindFrontmatter>
