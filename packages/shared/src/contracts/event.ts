import { v7 } from 'uuid'
import { z } from 'zod'
import { EVENT_TYPES } from './eventTypes'

export const ACTORS = ['sara', 'boris', 'client', 'system', 'profi'] as const
export type Actor = (typeof ACTORS)[number]

/** C1: the envelope shared by every journal event. */
export const EventEnvelope = z.object({
  id: z.uuid(),
  type: z.enum(EVENT_TYPES),
  v: z.number().int().positive(),
  entity: z.object({ kind: z.string().min(1), id: z.string().min(1) }),
  account_id: z.string().nullable(),
  actor: z.enum(ACTORS),
  occurred_at: z.iso.datetime(),
  recorded_at: z.iso.datetime().optional(),
  causation_id: z.uuid().nullable(),
  correlation_id: z.uuid(),
  reason: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
})
export type EventEnvelope = z.infer<typeof EventEnvelope>

export type NewEvent = Omit<EventEnvelope, 'id' | 'recorded_at'> & { id?: string }

export function newEventId(): string {
  return v7()
}
