import { timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/client'
import { conversation } from '../db/schema'
import { markShown, unmarkShown } from '../notify/forum'
import { rowOf } from './store'
import type { ConversationRow } from './types'

/**
 * Lora tells how a call went (Boris, 03.11): she keeps the files of the leads and writes the outcome and the next step
 * after Boris's story, with a link to the topic. The call has its own token (`SARA_LORA_TOKEN`; none, no input), a key of
 * her own so that a repeat changes nothing, and finds the client by the order's number or the topic's key. What is
 * written to it is the words of the outcome, never kept in the journal. See docs/ops/lora-meeting-result.md.
 */

export const LoraResult = z.object({
  /** Her own key of this note: a repeat of it is accepted and changes nothing. */
  key: z.string().min(1).max(200),
  order_id: z.string().min(1).max(40).optional(),
  /** The topic's key: the order's number, or `conv:<id>` for a chat without an order. */
  topic_key: z.string().min(1).max(80).optional(),
  /** False: the call did not take place. Default: it did. */
  held: z.boolean().optional(),
  /** When the call was (ISO 8601). */
  at: z.iso.datetime({ offset: true }).optional(),
  result: z.string().trim().min(1).max(1500),
  next_step: z.string().trim().max(500).optional(),
  /** The day of the next step, `YYYY-MM-DD` (Moscow). */
  next_step_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})
export type LoraResult = z.infer<typeof LoraResult>

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function conversationOf(db: Db, b: LoraResult): Promise<ConversationRow | null> {
  const key = b.topic_key ?? b.order_id
  if (!key) return null
  const [row] = key.startsWith('conv:')
    ? await db
        .select()
        .from(conversation)
        .where(eq(conversation.id, key.slice(5)))
    : await db.select().from(conversation).where(eq(conversation.orderId, key))
  return row ? rowOf(row) : null
}

export const topicKeyOf = (c: ConversationRow) => c.orderId ?? `conv:${c.id}`

export function registerLoraRoute(
  app: FastifyInstance,
  d: {
    db: Db
    token: string | undefined
    record(conv: ConversationRow, r: LoraResult): Promise<void>
  },
): void {
  app.post('/internal/lora/meeting-result', async (req, reply) => {
    if (!d.token) return reply.code(503).send({ error: 'the input is off' })
    const given = req.headers['x-sara-lora-token']
    if (typeof given !== 'string' || !same(given, d.token))
      return reply.code(401).send({ error: 'unauthorized' })
    const parsed = LoraResult.safeParse(req.body)
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'bad request', issues: parsed.error.issues.map((i) => i.path.join('.')) })
    const body = parsed.data
    if (!body.order_id && !body.topic_key)
      return reply.code(400).send({ error: 'order_id or topic_key is needed' })
    const conv = await conversationOf(d.db, body)
    if (!conv) return reply.code(404).send({ error: 'no such client' })
    const key = topicKeyOf(conv)
    const ref = `lora:${body.key}`
    if (!(await markShown(d.db, key, ref))) return { accepted: true, duplicate: true }
    try {
      await d.record(conv, body)
    } catch (e) {
      // Not written: the key is free again, her retry writes it.
      await unmarkShown(d.db, key, ref).catch(() => {})
      console.error('lora result not recorded', e instanceof Error ? e.message.slice(0, 200) : e)
      return reply.code(500).send({ error: 'not recorded, try again' })
    }
    return { accepted: true, duplicate: false }
  })
}
