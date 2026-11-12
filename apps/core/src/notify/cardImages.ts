import { randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { DbOrTx } from '../db/client'
import { cardImage } from '../db/schema'

/**
 * The pictures of picture cards for Telegram's link preview (FR-NOTIF-6, 12.11.2026). Telegram fetches the address
 * from its own servers, so the route needs no login: the token is 144 random bits and lives a few days, each state of
 * a card has its own, and the picture holds nothing the card in Telegram does not.
 */

/** A picture is kept this long: Telegram fetches it at once and keeps its own copy of the preview. */
const KEEP_MS = 3 * 24 * 3600_000
const TOKEN = /^[A-Za-z0-9_-]{24}$/

/** Keeps a picture under a new token and drops those past `KEEP_MS`; the token for its address. */
export async function keepCardImage(
  db: DbOrTx,
  png: Buffer,
  now: Date = new Date(),
): Promise<string> {
  const token = randomBytes(18).toString('base64url')
  await db.insert(cardImage).values({ token, png })
  await db
    .delete(cardImage)
    .where(lt(cardImage.createdAt, new Date(now.getTime() - KEEP_MS).toISOString()))
  return token
}

/** The address Telegram fetches the picture from: the core's own, behind the pult's domain (Caddy sends /api/* here). */
export const cardImageUrl = (publicUrl: string, token: string) =>
  `${publicUrl.replace(/\/+$/, '')}/api/card/${token}.png`

/** GET /api/card/<token>.png: the picture, or 404 for anything else. */
export function registerCardImageRoutes(app: FastifyInstance, d: { db: DbOrTx }): void {
  app.get<{ Params: { file: string } }>('/api/card/:file', async (req, reply) => {
    const token = req.params.file.replace(/\.png$/, '')
    if (!TOKEN.test(token)) return reply.code(404).send()
    const [row] = await d.db
      .select({ png: cardImage.png })
      .from(cardImage)
      .where(eq(cardImage.token, token))
    if (!row) return reply.code(404).send()
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'public, max-age=86400, immutable')
      .send(row.png)
  })
}
