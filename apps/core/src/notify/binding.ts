import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { ownerAuth } from '../db/schema'

export async function boundChat(db: DbOrTx): Promise<number | null> {
  const [row] = await db
    .select({ chat: ownerAuth.telegramChatId })
    .from(ownerAuth)
    .where(eq(ownerAuth.id, 1))
  return row?.chat ?? null
}

export async function bindChat(db: DbOrTx, chatId: number, userId: number): Promise<void> {
  const now = new Date().toISOString()
  await db
    .insert(ownerAuth)
    .values({ id: 1, telegramChatId: chatId, telegramUserId: userId, updatedAt: now })
    .onConflictDoUpdate({
      target: ownerAuth.id,
      set: { telegramChatId: chatId, telegramUserId: userId, updatedAt: now },
    })
}

/** Boris's own Telegram user: in his forum only his updates count (T9). */
export async function boundUser(db: DbOrTx): Promise<number | null> {
  const [row] = await db
    .select({ user: ownerAuth.telegramUserId })
    .from(ownerAuth)
    .where(eq(ownerAuth.id, 1))
  return row?.user ?? null
}
