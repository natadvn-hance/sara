import { EventEnvelope, newEventId, PROFI_EVENT_PAYLOADS, type ProfiEventType } from '@sara/shared'
import type { NodeDbOrTx } from '../db/client'
import { outboxNode } from '../db/schema'

export type NodeEvent = {
  type: ProfiEventType
  accountId: string
  entity: { kind: string; id: string }
  payload: unknown
  correlationId?: string
  occurredAt?: string
}

/** Builds a C1 envelope from Profi-MCP and queues it, in the caller's transaction with its raw data. */
export async function queueEvent(tx: NodeDbOrTx, e: NodeEvent): Promise<EventEnvelope> {
  const payload = PROFI_EVENT_PAYLOADS[e.type].parse(e.payload)
  const envelope = EventEnvelope.parse({
    id: newEventId(),
    type: e.type,
    v: 1,
    entity: e.entity,
    account_id: e.accountId,
    actor: 'profi',
    occurred_at: e.occurredAt ?? new Date().toISOString(),
    causation_id: null,
    correlation_id: e.correlationId ?? newEventId(),
    reason: null,
    payload,
  })
  await tx.insert(outboxNode).values({ eventId: envelope.id, payload: envelope })
  return envelope
}
