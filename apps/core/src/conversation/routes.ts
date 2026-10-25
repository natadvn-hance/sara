import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSession } from '../auth/session'
import { COMMAND_TEXTS, type CommandDeps, close, giveBack, say, take } from './commands'
import { getConversation } from './store'

const ReturnBody = z.object({ note: z.string().trim().min(1).max(1000).optional() })
const SayBody = z.object({
  text: z.string().trim().min(1).max(4000),
  /** A repeat of the same call with the same key is one message to the client. */
  key: z.string().min(1).max(100).optional(),
})

export const ROUTE_ERRORS = {
  noConversation: 'Такого разговора нет.',
  badText: 'Нужен текст для клиента.',
} as const

/**
 * Boris's commands from the pult and the Mini App (FR-CONV-11): the same functions the bot's buttons call, so the
 * same events. Only with the owner's session.
 */
export function registerConversationRoutes(app: FastifyInstance, d: CommandDeps): void {
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)
    const known = async (id: string) =>
      z.uuid().safeParse(id).success ? getConversation(d.db, id) : null

    scoped.post('/api/conversations/:id/take', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!(await known(id))) return reply.code(404).send({ error: ROUTE_ERRORS.noConversation })
      await take(d.db, id)
      return { message: COMMAND_TEXTS.taken }
    })

    scoped.post('/api/conversations/:id/return', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!(await known(id))) return reply.code(404).send({ error: ROUTE_ERRORS.noConversation })
      const body = ReturnBody.safeParse(req.body ?? {})
      await giveBack(d.db, id, body.success ? (body.data.note ?? null) : null)
      return { message: COMMAND_TEXTS.returned }
    })

    scoped.post('/api/conversations/:id/say', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!(await known(id))) return reply.code(404).send({ error: ROUTE_ERRORS.noConversation })
      const body = SayBody.safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: ROUTE_ERRORS.badText })
      const key = body.data.key ? `say:api:${body.data.key}` : undefined
      return { message: await say(d, id, body.data.text, key) }
    })

    scoped.post('/api/conversations/:id/close', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!(await known(id))) return reply.code(404).send({ error: ROUTE_ERRORS.noConversation })
      await close(d.db, id)
      return { message: COMMAND_TEXTS.closed }
    })
  })
}
