import { newEventId } from '@sara/shared'
import type { Db } from '../../src/db/client'
import { lead, leadScore, task } from '../../src/db/schema'

/** A lead with a live score and an open decision task created `ageHours` ago. */
export async function leadWithScore(
  db: Db,
  id: string,
  score: number,
  ageHours = 1,
): Promise<string> {
  await db.insert(lead).values({
    id,
    accountId: 'hance-marketing',
    title: 'Реклама на ТВ',
    category: 'Реклама на ТВ',
    city: 'Москва',
    text: 'Нужны федеральные каналы',
    clientName: 'Андрей',
    budgetText: null,
    bidPriceRub: 148,
    seenAt: new Date().toISOString(),
    status: 'queued',
    correlationId: newEventId(),
  })
  await db.insert(leadScore).values({
    id: newEventId(),
    leadId: id,
    version: 1,
    score,
    decision: score >= 56 ? 'show' : 'drop',
    stopFactor: null,
    redFlags: [],
    axes: [],
    reason: 'так',
    confidence: 0.9,
    model: 'haiku',
  })
  const createdAt = new Date(Date.now() - ageHours * 3600_000).toISOString()
  const taskId = newEventId()
  await db.insert(task).values({
    id: taskId,
    kind: 'lead_decision',
    entityKind: 'lead',
    entityId: id,
    createdAt,
  })
  return taskId
}
