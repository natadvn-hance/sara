import type { DbOrTx } from '../../db/client'
import type { LessonRow, NewLesson } from '../types'

/** Keeps a lesson and its mind proposals (FR-TRAIN-6). Part A writes the body. */
export async function createLesson(
  _tx: DbOrTx,
  _l: NewLesson,
): Promise<{ id: string; n: number; created: boolean }> {
  throw new Error('lessons are not built')
}

/** Boris's yes, no or «не важно» on a lesson, once. Part A writes the body. */
export async function decideLesson(
  _db: DbOrTx,
  _id: string,
  _d: { decision: 'yes' | 'no' | 'skip'; reason?: string; insight?: string },
): Promise<LessonRow | null> {
  throw new Error('lessons are not built')
}
