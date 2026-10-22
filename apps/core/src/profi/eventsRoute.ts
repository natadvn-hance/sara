import { EventEnvelope } from '@sara/shared'
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
    const isNew = await appendEventIfNew(d.db, parsed.data)
    if (isNew) await d.onEvent(parsed.data)
    return { accepted: true, duplicate: !isNew }
  })
}
