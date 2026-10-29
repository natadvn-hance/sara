import { z } from 'zod'
import { EntityRef } from './inbox'

/** «Журнал», the trace and the search (pult v2 design 9): Sara's steps, never a client's text. */

const at = z.string()

export const JournalRow = z.object({
  id: z.string(),
  type: z.string(),
  /** The same step in Boris's words, when the pult knows how to say it. */
  text: z.string(),
  at,
  actor: z.string(),
  entity: EntityRef.nullable(),
  reason: z.string().nullable(),
  correlationId: z.string(),
})
export type JournalRow = z.infer<typeof JournalRow>

export const JournalView = z.object({
  items: z.array(JournalRow),
  /** The `before` of the next page; null: the end. */
  next: z.string().nullable(),
  /** The event types seen lately, for the filter. */
  types: z.array(z.string()),
})
export type JournalView = z.infer<typeof JournalView>

export const TraceView = z.object({
  correlationId: z.string(),
  entity: EntityRef.nullable(),
  events: z.array(JournalRow),
  calls: z.array(
    z.object({
      id: z.string(),
      role: z.string(),
      model: z.string(),
      ok: z.boolean(),
      ms: z.number().int(),
      at,
      errorClass: z.string().nullable(),
    }),
  ),
})
export type TraceView = z.infer<typeof TraceView>

export const SearchHit = z.object({
  kind: z.enum(['lead', 'client', 'mind', 'section', 'meeting']),
  id: z.string(),
  title: z.string(),
  sub: z.string().nullable(),
  link: z.string(),
})
export type SearchHit = z.infer<typeof SearchHit>

export const SearchView = z.object({ q: z.string(), hits: z.array(SearchHit) })
export type SearchView = z.infer<typeof SearchView>
