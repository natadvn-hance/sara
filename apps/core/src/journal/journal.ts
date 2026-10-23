import { EventEnvelope, type NewEvent, newEventId } from '@sara/shared'
import { and, asc, eq, type SQL } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { event } from '../db/schema'

const iso = (v: string) => new Date(v).toISOString()

function toRow(e: EventEnvelope) {
  return {
    id: e.id,
    type: e.type,
    v: e.v,
    entityKind: e.entity.kind,
    entityId: e.entity.id,
    accountId: e.account_id,
    actor: e.actor,
    occurredAt: e.occurred_at,
    recordedAt: e.recorded_at ?? new Date().toISOString(),
    causationId: e.causation_id,
    correlationId: e.correlation_id,
    reason: e.reason,
    payload: e.payload,
  }
}

function fromRow(r: typeof event.$inferSelect): EventEnvelope {
  return EventEnvelope.parse({
    id: r.id,
    type: r.type,
    v: r.v,
    entity: { kind: r.entityKind, id: r.entityId },
    account_id: r.accountId,
    actor: r.actor,
    occurred_at: iso(r.occurredAt),
    recorded_at: iso(r.recordedAt),
    causation_id: r.causationId,
    correlation_id: r.correlationId,
    reason: r.reason,
    payload: r.payload,
  })
}

/** Appends one C1 event; the envelope is checked against the contract first. */
export async function appendEvent(db: DbOrTx, e: NewEvent): Promise<EventEnvelope> {
  const full = EventEnvelope.parse({
    ...e,
    id: e.id ?? newEventId(),
    occurred_at: iso(e.occurred_at),
    recorded_at: new Date().toISOString(),
  })
  await db.insert(event).values(toRow(full))
  return full
}

/** Stores an event that came from outside with its own id; false if it was already stored. */
export async function appendEventIfNew(db: DbOrTx, e: EventEnvelope): Promise<boolean> {
  const full = EventEnvelope.parse({ ...e, recorded_at: new Date().toISOString() })
  const inserted = await db
    .insert(event)
    .values(toRow(full))
    .onConflictDoNothing({ target: event.id })
    .returning({ id: event.id })
  return inserted.length > 0
}

export async function listEvents(
  db: DbOrTx,
  filter: { correlationId?: string; type?: string },
): Promise<EventEnvelope[]> {
  const conds: SQL[] = []
  if (filter.correlationId) conds.push(eq(event.correlationId, filter.correlationId))
  if (filter.type) conds.push(eq(event.type, filter.type))
  const rows = await db
    .select()
    .from(event)
    .where(and(...conds))
    .orderBy(asc(event.id))
  return rows.map(fromRow)
}
