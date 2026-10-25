import { sql } from 'drizzle-orm'
import { jobRun } from '../db/schema'
import { takeNotice } from './notices'
import { SCHOOL_TEXTS } from './texts'
import type { SchoolDeps } from './types'

const MSK_MS = 3 * 60 * 60_000

/**
 * ⚙️ once a day when the night's exchange with GitHub failed (M5 design 5.3): the night job only journals it, the
 * message waits for the school's day hours.
 */
export async function syncNoticeStep(
  d: Pick<SchoolDeps, 'db' | 'notifier'>,
  now: Date,
): Promise<void> {
  const day = new Date(now.getTime() + MSK_MS).toISOString().slice(0, 10)
  const failed = await d.db.execute(sql`
    select 1 from core.event where type = 'mind.sync_failed'
      and occurred_at > ${new Date(now.getTime() - 24 * 60 * 60_000).toISOString()}
      and not exists (select 1 from core.event e2 where e2.type = 'mind.synced'
        and e2.occurred_at > core.event.occurred_at)
    limit 1`)
  if (failed.rows.length === 0) return
  const [told] = await d.db
    .execute(sql`select 1 from core.job_run where name = 'sync_notice' and day = ${day}`)
    .then((r) => r.rows)
  if (told) return
  if (!(await takeNotice(d.db, now, 'sync_failed'))) return
  await d.db.insert(jobRun).values({ name: 'sync_notice', day }).onConflictDoNothing()
  await d.notifier.sendText(SCHOOL_TEXTS.syncFailed)
}
