import type { FastifyReply, FastifyRequest } from 'fastify'

export const SESSION_COOKIE = 'sara_session'
/** The browser's sign-in lasts 90 days, as with old Sara (M7 design, decision 3). */
const MAX_AGE_S = 90 * 24 * 3600

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

/**
 * The Mini App's way in (pult v2 design 7): `Authorization: tma <initData>` checked against the bot's token and
 * Boris's Telegram user. Set by the server once it has the database and the secrets; unset, only the cookie works.
 */
type TmaCheck = (initData: string, ip: string) => Promise<'ok' | 'denied' | 'too_many'>
let tmaCheck: TmaCheck | null = null

export function setTmaCheck(check: TmaCheck | null): void {
  tmaCheck = check
}

const tmaOf = (req: FastifyRequest): string | null => {
  const h = req.headers.authorization
  return typeof h === 'string' && h.startsWith('tma ') ? h.slice(4).trim() : null
}

/** Boris is in: by the signed cookie of the browser, or by the signed `initData` of the Mini App. */
export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (hasSession(req)) return
  const tma = tmaOf(req)
  if (tma && tmaCheck) {
    const r = await tmaCheck(tma, req.ip)
    if (r === 'ok') return
    if (r === 'too_many')
      return void (await reply.code(429).send({ error: 'Слишком много попыток. Подожди минуту.' }))
    return void (await reply.code(401).send({ error: 'Открой приложение заново из Telegram.' }))
  }
  await reply.code(401).send({ error: 'Нужно войти в пульт.' })
}
