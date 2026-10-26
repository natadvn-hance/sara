import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { account } from '../db/schema'
import { getSetting } from '../settings/store'
import { getConversation } from './store'

/**
 * Why a text may not go to this client right now, or null: the «Пишет клиентам» pause holds Sara's own texts (Boris's
 * own words pass it, as v1), and the account's pause, its logout or a ban hold everything. Known without reading the
 * chat, so a press on a card is refused before the card is taken, and the card stays for a later press.
 */
export async function sendHold(
  db: Db,
  conversationId: string,
  author: 'sara' | 'boris',
): Promise<string | null> {
  const conv = await getConversation(db, conversationId)
  if (!conv) return null
  if (author === 'sara' && !(await getSetting(db, 'outbound.messages')))
    return 'пауза «Пишет клиентам»'
  const [a] = await db.select().from(account).where(eq(account.id, conv.accountId))
  if (a?.paused) return 'аккаунт на паузе'
  if (a?.loginState === 'dead' || a?.loginState === 'banned')
    return 'аккаунт не вошёл в Профи.ру или заблокирован'
  return null
}

/** What Boris is told when a press is held: the card stays open. */
export const holdText = (why: string) =>
  `Сейчас не отправляю: ${why}. Карточка остаётся, нажми позже.`
