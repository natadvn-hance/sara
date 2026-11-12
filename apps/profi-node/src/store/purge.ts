import { and, eq, isNotNull, lt, or } from 'drizzle-orm'
import type { NodeDb } from '../db/client'
import { bidAttempt, messageAttempt, outboxNode, rawEvent, rawOrder } from '../db/schema'

const DAY = 24 * 3600 * 1000

/** How long the site's answers (`raw_event` of kind `response`) are kept: 11.11.2026 they were 3.5 GB of the 4 GB base and
 * grew about 200 MB a day; what Sara needs from them is already in orders, messages and core events (Boris: «10 дней»). */
export const ANSWER_DAYS = 10

/**
 * Retention (data dictionary, section 4): the site's answers 10 days; other raw records, bid presses and message presses
 * 30 days; confirmed queue rows 7 days.
 */
export async function purgeOld(db: NodeDb, now: Date): Promise<{ raw: number; outbox: number }> {
  const rawBefore = new Date(now.getTime() - 30 * DAY).toISOString()
  const answersBefore = new Date(now.getTime() - ANSWER_DAYS * DAY).toISOString()
  const outboxBefore = new Date(now.getTime() - 7 * DAY).toISOString()
  const ev = await db
    .delete(rawEvent)
    .where(
      or(
        lt(rawEvent.receivedAt, rawBefore),
        and(eq(rawEvent.kind, 'response'), lt(rawEvent.receivedAt, answersBefore)),
      ),
    )
    .returning({ id: rawEvent.id })
  const ord = await db
    .delete(rawOrder)
    .where(lt(rawOrder.seenAt, rawBefore))
    .returning({ id: rawOrder.orderId })
  await db.delete(bidAttempt).where(lt(bidAttempt.pressedAt, rawBefore))
  await db.delete(messageAttempt).where(lt(messageAttempt.pressedAt, rawBefore))
  const out = await db
    .delete(outboxNode)
    .where(and(isNotNull(outboxNode.confirmedAt), lt(outboxNode.confirmedAt, outboxBefore)))
    .returning({ id: outboxNode.eventId })
  return { raw: ev.length + ord.length, outbox: out.length }
}
