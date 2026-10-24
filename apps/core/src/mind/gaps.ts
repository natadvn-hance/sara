import { newEventId, type Topic } from '@sara/shared'
import { and, desc, gte, isNull } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { mindGap } from '../db/schema'
import { appendEvent } from '../journal/journal'

/** Same question in other words of case, spaces and the final mark. */
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:!?…]+$/u, '')
    .trim()

/**
 * Keeps what a turn lacked to answer (FR-MIND-4). The journal gets only the topic: the text may carry what the client
 * wrote. A blank text is not a gap.
 */
export async function recordGap(
  db: DbOrTx,
  i: { turnId: string; text: string; topic: Topic },
): Promise<void> {
  const text = i.text.trim()
  if (!text) return
  const id = newEventId()
  await db.transaction(async (tx) => {
    await tx.insert(mindGap).values({ id, turnId: i.turnId, text, topic: i.topic })
    await appendEvent(tx, {
      type: 'mind.gap_recorded',
      v: 1,
      entity: { kind: 'conv_turn', id: i.turnId },
      account_id: null,
      actor: 'sara',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: id,
      reason: null,
      payload: { topic: i.topic },
    })
  })
}

/**
 * The most frequent gap of the last `sinceDays` days not yet asked about, by normalized text; a tie goes to the
 * fresher one. Its text is the latest wording.
 */
export async function topGap(
  db: DbOrTx,
  sinceDays: number,
): Promise<{ text: string; count: number } | null> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const rows = await db
    .select({ text: mindGap.text })
    .from(mindGap)
    .where(and(isNull(mindGap.questionId), gte(mindGap.createdAt, since)))
    .orderBy(desc(mindGap.createdAt), desc(mindGap.id))
  const groups = new Map<string, { text: string; count: number }>()
  for (const r of rows) {
    const key = normalize(r.text)
    const g = groups.get(key)
    if (g) g.count += 1
    else groups.set(key, { text: r.text, count: 1 })
  }
  let best: { text: string; count: number } | null = null
  for (const g of groups.values()) if (!best || g.count > best.count) best = g
  return best
}
