import type { FastifyReply, FastifyRequest } from 'fastify'

export const SESSION_COOKIE = 'sara_session'
const MAX_AGE_S = 30 * 24 * 3600

export function startSession(reply: FastifyReply, production: boolean): void {
  reply.setCookie(SESSION_COOKIE, `owner:${Date.now()}`, {
    signed: true,
    httpOnly: true,
    sameSite: 'strict',
    secure: production,
    path: '/',
    maxAge: MAX_AGE_S,
  })
}

export function hasSession(req: FastifyRequest): boolean {
  const raw = req.cookies[SESSION_COOKIE]
  if (!raw) return false
  const { valid, value } = req.unsignCookie(raw)
  if (!valid || !value?.startsWith('owner:')) return false
  const issued = Number(value.slice('owner:'.length))
  return Number.isFinite(issued) && Date.now() - issued < MAX_AGE_S * 1000
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!hasSession(req)) await reply.code(401).send({ error: 'Нужно войти в пульт.' })
}
