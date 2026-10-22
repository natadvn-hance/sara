import { EventEnvelope } from '@sara/shared'

/** The journal is append-only and kept for years, so it never stores the client's name or text (ADR-016). */
export function journalCopy(e: EventEnvelope): EventEnvelope {
  if (e.type !== 'profi.order_seen') return e
  const { client_name: _name, text: _text, ...rest } = e.payload as Record<string, unknown>
  return { ...e, payload: rest }
}

import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/client'
import { appendEventIfNew } from '../journal/journal'

/** Contract C8: Profi-MCP delivers its events here; each event id is accepted once. */
export function registerProfiEventsRoute(
  app: FastifyInstance,
  d: { db: Db; nodeToken: string; onEvent(e: EventEnvelope): Promise<void> },
): void {
  app.post('/internal/profi/events', async (req, reply) => {
    if (req.headers['x-sara-node-token'] !== d.nodeToken)
      return reply.code(401).send({ error: 'unauthorized' })
    const parsed = EventEnvelope.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'envelope breaks contract C1' })
    const isNew = await appendEventIfNew(d.db, journalCopy(parsed.data))
    // Called for repeats too: if processing failed after the event was journaled, the node's retry
    // starts it again. Processing is idempotent (workflow id lead:<order>).
    await d.onEvent(parsed.data)
    return { accepted: true, duplicate: !isNew }
  })
}
