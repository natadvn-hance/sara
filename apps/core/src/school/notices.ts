import { newEventId } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { jobRun } from '../db/schema'
import { getSetting } from '../settings/store'
import { NOTICE_KINDS, type NoticeKind } from './types'

const MSK_MS = 3 * 60 * 60_000
/** The school writes from 10:00 to 22:59 Moscow time; at night nothing goes and nothing is deferred. */
const FROM_HOUR = 10
const TO_HOUR = 23
/** Rare and urgent: they go over the day's count (M5 design 5.16, the top of the table). */
const ALWAYS: NoticeKind[] = ['golden_worse', 'sync_failed']

const mskDay = (now: Date) => new Date(now.getTime() + MSK_MS).toISOString().slice(0, 10)
const mskHour = (now: Date) => new Date(now.getTime() + MSK_MS).getUTCHours()

/**
 * May the school send this message of its own accord now (FR-NOTIF-3, M5 design 5.16): only from 10:00 to 22:59
 * Moscow time and only while today's messages are under `school.messages_per_day`. A message over the count is
 * deferred: it becomes a line of the evening summary and the caller tries again tomorrow. The place is taken under a
 * lock, so two ticks never make one message too many. The answer is the place's name (null: not now), to give it back
 * with `releaseNotice` when the message does not go.
 */
export async function takeNotice(db: Db, now: Date, kind: NoticeKind): Promise<string | null> {
  const hour = mskHour(now)
  if (hour < FROM_HOUR || hour >= TO_HOUR) return null
  const day = mskDay(now)
  const cap = await getSetting(db, 'school.messages_per_day')
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('school-notices'))`)
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(jobRun)
      .where(sql`${jobRun.day} = ${day} and ${jobRun.name} like 'notice:%'`)
    if (n >= cap && !ALWAYS.includes(kind)) {
      await tx
        .insert(jobRun)
        .values({ name: `deferred:${kind}`, day })
        .onConflictDoNothing()
      return null
    }
    const name = `notice:${kind}:${newEventId()}`
    await tx.insert(jobRun).values({ name, day })
    return name
  })
}

/** A message that did not go (Telegram refused, nothing left to send) gives its place of the day back. */
export async function releaseNotice(db: Db, name: string): Promise<void> {
  await db.delete(jobRun).where(eq(jobRun.name, name))
}

/** The messages that did not fit the day, most important first: lines of the evening summary. */
export async function deferredNotices(db: Db, day: string): Promise<NoticeKind[]> {
  const rows = await db.execute<{ name: string }>(
    sql`select name from core.job_run where day = ${day} and name like 'deferred:%'`,
  )
  const kinds = new Set(rows.rows.map((r) => r.name.slice('deferred:'.length)))
  return NOTICE_KINDS.filter((k) => kinds.has(k))
}
