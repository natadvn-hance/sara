import { eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { DbOrTx } from '../db/client'
import { ownerAuth } from '../db/schema'
import type { SecretStore } from '../secrets/store'
import { blocked, recordFailure } from './limiter'
import { hasSession } from './session'
import { tmaFrom, verifyInitData } from './telegram'

export const OWNER_TEXTS = {
  signIn: 'Нужно войти в пульт.',
  reopen: 'Открой приложение заново.',
  tooMany: 'Слишком много попыток. Подожди минуту.',
}

async function ownerUserId(db: DbOrTx): Promise<number | null> {
  const [row] = await db
    .select({ id: ownerAuth.telegramUserId })
    .from(ownerAuth)
    .where(eq(ownerAuth.id, 1))
  return row?.id ?? null
}

/**
 * The owner's way in (M7 design, section 7): the password session cookie in a browser, or the Mini App's signed
 * launch data in `Authorization: tma <initData>` on every request inside Telegram (a cookie does not reach the
 * Mini App when Telegram frames it). A bad signature counts as a failed sign-in for its address.
 */
export function requireOwner(d: { db: DbOrTx; secrets: SecretStore }) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (hasSession(req)) return
    const initData = tmaFrom(req.headers.authorization)
    if (!initData) return void (await reply.code(401).send({ error: OWNER_TEXTS.signIn }))
    if (blocked(req.ip)) return void (await reply.code(429).send({ error: OWNER_TEXTS.tooMany }))
    const [botToken, owner] = await Promise.all([
      d.secrets.get('telegram_bot_token'),
      ownerUserId(d.db),
    ])
    const check = verifyInitData(initData, {
      botToken: botToken ?? '',
      ownerUserId: owner,
      nowMs: Date.now(),
    })
    if (check.ok) return
    recordFailure(req.ip)
    await reply
      .code(401)
      .send({ error: check.reason === 'expired' ? OWNER_TEXTS.reopen : OWNER_TEXTS.signIn })
  }
}
