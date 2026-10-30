// pnpm --filter @sara/core screen:dry [days]: the screen's criteria 1-3 over the orders of the last days (7 by
// default), read only: what it would stop, and how many of those Boris was shown or bid on. Prints numbers and order
// ids, never the client's words. Runs where the database is, inside the core container.
import { sql } from 'drizzle-orm'
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { getSetting } from '../settings/store'
import { loadFormParts } from './screen'
import { type DryRow, dryReport, dryScreen } from './screenDry'

const days = Number(process.argv[2] ?? 7)
if (!Number.isInteger(days) || days <= 0) throw new Error('Нужно: screen:dry [дней]')
const { db, close } = createDb(loadConfig().databaseUrl)
try {
  const rows = await db.execute<DryRow>(sql`
    select l.id, l.title, l.text, l.client_info as "clientInfo", l.seen_at as "seenAt",
      exists (select 1 from core.task t where t.kind = 'lead_decision' and t.entity_id = l.id) as shown,
      l.status = 'bid_sent' as bid
    from core.lead l
    where l.seen_at > now() - make_interval(days => ${days}::int)
    order by l.seen_at`)
  const min = await getSetting(db, 'screen.min_own_words')
  const form = await loadFormParts(db)
  console.log(
    dryReport(
      dryScreen(
        rows.rows.map((r) => ({ ...r, seenAt: new Date(r.seenAt).toISOString() })),
        form,
        min,
      ),
      min,
    ),
  )
} finally {
  await close()
}
