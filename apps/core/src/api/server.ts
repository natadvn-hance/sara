import { randomBytes } from 'node:crypto'
import cookie from '@fastify/cookie'
import { eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { registerAccountRoutes } from '../accounts/routes'
import { setTmaCheck } from '../auth/session'
import { checkInitData, tooManyBadSignatures } from '../auth/telegramAuth'
import { ownerAuth } from '../db/schema'
import { registerDirectionRoutes } from '../direction/routes'
import { registerHealthRoutes } from '../health/routes'
import { registerPultRoutes } from '../pult/routes'
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
  // The Mini App signs in by Telegram's signature of the bound owner (pult v2 design 7); never logged.
  setTmaCheck(async (initData, ip) => {
    if (tooManyBadSignatures(ip, false)) return 'too_many'
    const token = await d.secrets.get('telegram_bot_token')
    const [owner] = await d.db
      .select({ user: ownerAuth.telegramUserId })
      .from(ownerAuth)
      .where(eq(ownerAuth.id, 1))
    const r = token ? checkInitData(initData, token) : null
    const ok = r?.ok === true && owner?.user != null && r.userId === Number(owner.user)
    if (ok) return 'ok'
    return tooManyBadSignatures(ip, true) ? 'too_many' : 'denied'
  })
  registerSetupRoutes(app, d)
  registerHealthRoutes(app, d)
  registerAccountRoutes(app, d)
  registerDirectionRoutes(app, d)
  registerPultRoutes(app, d)
  return app
}
