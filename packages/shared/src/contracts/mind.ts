import { z } from 'zod'

/** C6: fields at the top of every mind record. */
export const MindFrontmatter = z.object({
  id: z.string().min(1),
  type: z.enum(['knowledge', 'understanding', 'speech', 'judgment', 'example']),
  scope: z.string().min(1),
  status: z.enum(['confirmed', 'proposal', 'outdated']),
  version: z.number().int().positive(),
  sources: z.array(z.string().min(1)).min(1),
  valid_from: z.iso.date(),
  valid_to: z.iso.date().nullable(),
})
export type MindFrontmatter = z.infer<typeof MindFrontmatter>
