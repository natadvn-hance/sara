import { newEventId } from '@sara/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { DbOrTx } from '../../db/client'
import { lesson, mindProposal } from '../../db/schema'
import { appendEvent } from '../../journal/journal'
import { proposeMind } from '../../mind/proposals'
import type { LessonRow, NewLesson } from '../types'
import { previewOf, proposalKind, proposalPath } from './records'

const journal = (
  type: 'lesson.created' | 'lesson.decided',
  id: string,
  actor: 'sara' | 'boris',
  payload: Record<string, unknown>,
) => ({
  type,
  v: 1,
  entity: { kind: 'lesson', id },
  account_id: null,
  actor,
  occurred_at: new Date().toISOString(),
  causation_id: null,
  correlation_id: newEventId(),
  reason: null,
  payload,
})

const asRow = (r: typeof lesson.$inferSelect): LessonRow => r as LessonRow

/**
 * Keeps a lesson and one mind proposal per change (FR-TRAIN-6), all or nothing; «{n}» in a record id becomes the
 * lesson's serial number. A lesson from the same source is kept once: a second call returns the first one.
 */
export async function createLesson(
  db: DbOrTx,
  l: NewLesson,
): Promise<{ id: string; n: number; created: boolean }> {
  return db.transaction((tx) => insertLesson(tx, l))
}

async function insertLesson(
  tx: DbOrTx,
  l: NewLesson,
): Promise<{ id: string; n: number; created: boolean }> {
  const id = newEventId()
  const { changes, ...fields } = l
  const [row] = await tx
    .insert(lesson)
    .values({ id, ...fields })
    .onConflictDoNothing()
    .returning({ id: lesson.id, n: lesson.n })
  if (!row) {
    const [old] = await tx
      .select({ id: lesson.id, n: lesson.n })
      .from(lesson)
      .where(and(eq(lesson.source, l.source), eq(lesson.sourceRef, l.sourceRef)))
    if (!old) throw new Error('a lesson vanished between insert and select')
    return { ...old, created: false }
  }
  for (const c of changes) {
    const change = { ...c, recordId: c.recordId.replace('{n}', String(row.n)) }
    const kept = await proposeMind(tx, {
      path: proposalPath(change, row.n),
      content: previewOf(change),
      kind: proposalKind(change),
      source: `lesson:${row.n}`,
      lessonId: id,
      action: change.action,
      recordId: change.recordId,
      section: change.section,
      baseVersion: change.baseVersion,
      change,
    })
    if (!kept) throw new Error(`a proposal for ${change.recordId} already exists`)
  }
  await appendEvent(
    tx,
    journal('lesson.created', id, 'sara', { n: row.n, source: l.source, kind: l.kind }),
  )
  return { ...row, created: true }
}

/**
 * Boris's yes, no or «не важно» on a lesson, once (FR-TRAIN-6); null when it was already decided. «Нет» and «не
 * важно» decline the lesson's proposals at once, so they never come back; «да» leaves them to the mind writer.
 */
export async function decideLesson(
  db: DbOrTx,
  id: string,
  d: { decision: 'yes' | 'no' | 'skip'; reason?: string; insight?: string },
): Promise<LessonRow | null> {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString()
    const [row] = await tx
      .update(lesson)
      .set({
        state: d.decision,
        decidedAt: now,
        ...(d.reason !== undefined ? { reason: d.reason } : {}),
        ...(d.insight !== undefined ? { insight: d.insight } : {}),
      })
      .where(and(eq(lesson.id, id), inArray(lesson.state, ['ready', 'asked'])))
      .returning()
    if (!row) return null
    if (d.decision !== 'yes') {
      await tx
        .update(mindProposal)
        .set({
          state: 'declined',
          decidedAt: now,
          rejectReason: d.decision === 'skip' ? 'не важно' : (d.reason ?? 'Борис: нет'),
        })
        .where(and(eq(mindProposal.lessonId, id), eq(mindProposal.state, 'new')))
    }
    await appendEvent(
      tx,
      journal('lesson.decided', id, 'boris', {
        n: row.n,
        decision: d.decision,
        source: row.source,
      }),
    )
    return asRow(row)
  })
}
