import type { Db } from '../db/client'
import type { NoticeKind } from './types'

/** May the school send this message now: the day's count and the hours (M5 design 5.16). Part A writes the body. */
export async function takeNotice(_db: Db, _now: Date, _kind: NoticeKind): Promise<boolean> {
  return true
}

/** The messages that did not fit the day: lines of the evening summary. Part A writes the body. */
export async function deferredNotices(_db: Db, _day: string): Promise<NoticeKind[]> {
  return []
}
