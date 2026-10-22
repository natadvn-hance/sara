import { ProbeOutput } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../api/deps'
import { hashPassword, verifyPassword } from '../auth/password'
import { requireSession, startSession } from '../auth/session'
import { ownerAuth } from '../db/schema'
import { getMe } from '../notify/telegramApi'
import { completeStep, setupState } from './progress'

export const SETUP_ERRORS = {
  shortPassword: 'Пароль должен быть не короче 10 знаков.',
  passwordSet: 'Пароль уже задан. Войди с ним.',
  wrongPassword: 'Пароль не подходит.',
  tooManyLogins: 'Слишком много попыток. Подожди минуту.',
  tokenFormat:
    'Это не похоже на токен бота. Скопируй его из сообщения @BotFather целиком: цифры, двоеточие и длинная строка.',
  tokenUnknown:
    'Telegram не узнал этот токен. Проверь, что скопировал последний токен из @BotFather, или выпусти новый командой /token.',
  telegramNetwork: 'Не получилось связаться с Telegram. Проверь интернет и попробуй ещё раз.',
  claudeRefused:
    'Claude не принял токен. Запусти на Маке claude setup-token ещё раз и вставь новый токен.',
  claudeTimeout:
    'Claude не ответил за 30 секунд. Попробуй ещё раз; если повторится, проверь лимит подписки.',
  claudeLimit: 'Лимит подписки Claude исчерпан. Шаг можно пройти позже.',
} as const

const TOKEN_FORMAT = /^\d+:[A-Za-z0-9_-]{30,}$/
const PasswordBody = z.object({ password: z.string() })
const TokenBody = z.object({ token: z.string() })

async function passwordHash(d: AppDeps): Promise<string | null> {
  const [row] = await d.db
    .select({ h: ownerAuth.passwordHash })
    .from(ownerAuth)
    .where(eq(ownerAuth.id, 1))
  return row?.h ?? null
}

/** Login attempts per client address in the last minute. */
const attempts = new Map<string, number[]>()
function tooMany(ip: string): boolean {
  const now = Date.now()
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 60_000)
  recent.push(now)
  attempts.set(ip, recent)
  return recent.length > 5
}

export function registerSetupRoutes(app: FastifyInstance, d: AppDeps): void {
  app.get('/api/setup', async () => setupState(d.db))

  app.post('/api/setup/password', async (req, reply) => {
    const { password } = PasswordBody.parse(req.body)
    if (password.length < 10) return reply.code(400).send({ error: SETUP_ERRORS.shortPassword })
    if (await passwordHash(d)) return reply.code(409).send({ error: SETUP_ERRORS.passwordSet })
    const hash = await hashPassword(password)
    const now = new Date().toISOString()
    await d.db
      .insert(ownerAuth)
      .values({ id: 1, passwordHash: hash, updatedAt: now })
      .onConflictDoUpdate({ target: ownerAuth.id, set: { passwordHash: hash, updatedAt: now } })
    await completeStep(d.db, 'password')
    startSession(reply, d.production)
    return { ok: true }
  })

  app.post('/api/login', async (req, reply) => {
    if (tooMany(req.ip)) return reply.code(429).send({ error: SETUP_ERRORS.tooManyLogins })
    const { password } = PasswordBody.parse(req.body)
    const hash = await passwordHash(d)
    if (!hash || !(await verifyPassword(password, hash))) {
      return reply.code(401).send({ error: SETUP_ERRORS.wrongPassword })
    }
    startSession(reply, d.production)
    return { ok: true }
  })

  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)

    scoped.post('/api/setup/telegram', async (req, reply) => {
      const token = TokenBody.parse(req.body).token.trim()
      if (!TOKEN_FORMAT.test(token))
        return reply.code(400).send({ error: SETUP_ERRORS.tokenFormat })
      const me = await getMe(token, d.telegramApiRoot)
      if (!me.ok && me.reason === 'unauthorized')
        return reply.code(400).send({ error: SETUP_ERRORS.tokenUnknown })
      if (!me.ok) return reply.code(502).send({ error: SETUP_ERRORS.telegramNetwork })
      await d.secrets.set('telegram_bot_token', token)
      await d.bot.start(token)
      return { botUsername: me.username }
    })

    scoped.get('/api/setup/telegram/status', async () => {
      const bound = await d.bot.isBound()
      if (bound) await completeStep(d.db, 'telegram')
      return { bound, botUsername: d.bot.botUsername() }
    })

    scoped.post('/api/setup/claude', async (req, reply) => {
      const token = TokenBody.parse(req.body).token.trim()
      await d.secrets.set('claude_oauth_token', token)
      const r = await d.gateway.call('probe', 'Проверка связи.', ProbeOutput)
      if (r.ok) {
        await completeStep(d.db, 'claude')
        return { ok: true, durationMs: r.durationMs }
      }
      if (r.errorClass === 'timeout')
        return reply.code(504).send({ error: SETUP_ERRORS.claudeTimeout })
      if (r.errorClass === 'limit_reached')
        return reply.code(429).send({ error: SETUP_ERRORS.claudeLimit })
      return reply.code(400).send({ error: SETUP_ERRORS.claudeRefused })
    })
  })
}
