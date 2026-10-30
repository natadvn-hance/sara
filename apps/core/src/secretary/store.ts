import { newEventId } from '@sara/shared'
import { and, asc, count, desc, eq, gt, gte, lt, notInArray } from 'drizzle-orm'
import { moscowDayStart } from '../conversation/cards'
import type { Db, DbOrTx } from '../db/client'
import { lead, modelCall, secretaryMessage } from '../db/schema'

const DAY_MS = 24 * 3600_000
/** How long the chat is kept (ADR-027). */
const KEEP_MS = 7 * DAY_MS
/** What a turn remembers: the last messages of the last three days. */
export const MEMORY = { messages: 20, ms: 3 * DAY_MS }
/** Whose names are hidden from the model: the clients of the orders seen in these days (ADR-016). */
const NAMES_MS = 90 * DAY_MS
/** Words a lead's client field may hold that are no one's name: hidden, they would turn every «клиент» into a tag. */
const NOT_NAMES = new Set(['клиент', 'клиентка', 'заказчик', 'заказчица', 'пользователь', 'аноним'])

export type ChatLine = { author: 'boris' | 'sara'; text: string; at: string }

/** One line of the chat; lines older than a week go at the same time. */
export async function addLine(
  db: Db,
  l: { author: 'boris' | 'sara'; text: string; at: Date; telegramMessageId?: number | null },
): Promise<string> {
  const id = newEventId()
  await db.transaction(async (tx) => {
    await tx.insert(secretaryMessage).values({
      id,
      author: l.author,
      text: l.text,
      at: l.at.toISOString(),
      telegramMessageId: l.telegramMessageId ?? null,
    })
    await tx
      .delete(secretaryMessage)
      .where(lt(secretaryMessage.at, new Date(l.at.getTime() - KEEP_MS).toISOString()))
  })
  return id
}

/**
 * The memory of a turn, oldest first: the last lines up to `now` but the turn's own (`own`), which it reads as new.
 * Sara's answer to the turn before is in it even when Boris wrote again while she was answering.
 */
export async function memory(db: DbOrTx, now: Date, own: string[]): Promise<ChatLine[]> {
  const rows = await db
    .select({
      author: secretaryMessage.author,
      text: secretaryMessage.text,
      at: secretaryMessage.at,
    })
    .from(secretaryMessage)
    .where(
      and(
        gt(secretaryMessage.at, new Date(now.getTime() - MEMORY.ms).toISOString()),
        ...(own.length > 0 ? [notInArray(secretaryMessage.id, own)] : []),
      ),
    )
    .orderBy(desc(secretaryMessage.at))
    .limit(MEMORY.messages)
  return rows.reverse().map((r) => ({ ...r, author: r.author === 'sara' ? 'sara' : 'boris' }))
}

/** The Secretary's runs this Moscow day: every run that reached the CLI counts, an answer or not. */
export async function turnsToday(db: DbOrTx, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(modelCall)
    .where(
      and(
        eq(modelCall.role, 'secretary'),
        gt(modelCall.durationMs, 0),
        gte(modelCall.startedAt, moscowDayStart(now)),
      ),
    )
  return row?.n ?? 0
}

/** The client names a turn hides: of the orders seen in the last 90 days, the longest first. */
export async function clientNamesToHide(db: DbOrTx, now: Date): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: lead.clientName })
    .from(lead)
    .where(gte(lead.seenAt, new Date(now.getTime() - NAMES_MS).toISOString()))
    .orderBy(asc(lead.clientName))
  return rows
    .map((r) => r.name.trim())
    .filter((n) => n.length >= 2 && !NOT_NAMES.has(n.toLowerCase()) && /^\p{Lu}/u.test(n))
}
