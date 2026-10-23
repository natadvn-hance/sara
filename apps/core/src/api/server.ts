import { randomBytes } from 'node:crypto'
import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { registerAccountRoutes } from '../accounts/routes'
import { registerHealthRoutes } from '../health/routes'
import { registerSetupRoutes } from '../setup/routes'
import type { AppDeps } from './deps'

export async function buildServer(d: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const secret = await d.secrets.ensure('session_secret', () => randomBytes(32).toString('hex'))
  await app.register(cookie, { secret })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Неверный запрос.' })
    reply.log.error(err)
    return reply.code(500).send({ error: 'Что-то пошло не так. Посмотри «Состояние системы».' })
  })
  registerSetupRoutes(app, d)
  registerHealthRoutes(app, d)
  registerAccountRoutes(app, d)
  return app
}
