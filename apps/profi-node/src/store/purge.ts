import { and, isNotNull, lt } from 'drizzle-orm'
import type { NodeDb } from '../db/client'
import { bidAttempt, outboxNode, rawEvent, rawOrder } from '../db/schema'

const DAY = 24 * 3600 * 1000

/** Retention (data dictionary, section 4): raw records and bid presses 30 days, confirmed queue rows 7 days. */
export async function purgeOld(db: NodeDb, now: Date): Promise<{ raw: number; outbox: number }> {
  const rawBefore = new Date(now.getTime() - 30 * DAY).toISOString()
  const outboxBefore = new Date(now.getTime() - 7 * DAY).toISOString()
  const ev = await db
    .delete(rawEvent)
    .where(lt(rawEvent.receivedAt, rawBefore))
    .returning({ id: rawEvent.id })
  const ord = await db
    .delete(rawOrder)
    .where(lt(rawOrder.seenAt, rawBefore))
    .returning({ id: rawOrder.orderId })
  await db.delete(bidAttempt).where(lt(bidAttempt.pressedAt, rawBefore))
  const out = await db
    .delete(outboxNode)
    .where(and(isNotNull(outboxNode.confirmedAt), lt(outboxNode.confirmedAt, outboxBefore)))
    .returning({ id: outboxNode.eventId })
  return { raw: ev.length + ord.length, outbox: out.length }
}
