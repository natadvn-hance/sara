import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { getSetting } from '../settings/store'
import { getConversation } from './store'
import { startTurnFor } from './turn'
import type { ConversationRow } from './types'

/** At most this many missed conversations get their turn in one pass, so a catch-up never floods the model. */
const PER_PASS = 5
/** A client word older than this is history, not a missed turn. */
const MAX_AGE_DAYS = 7

/**
 * Conversations whose last word is a client's and which never got a turn (Boris, 31.10: a real client's first answer
 * was hidden by the site's own line behind it, so the turn did not start; Татьяна on 28.10, 95596098 on 31.10). Run once
 * at start: each such open conversation Sara leads gets its turn, whose draft comes to Boris on «Отправить». Returns how
 * many turns were started. Starting a turn twice for the same words is the one turn (the workflow is by anchor).
 */
export async function catchUpMissedTurns(
  d: { db: Db; start?: (conv: ConversationRow) => Promise<void> },
  now: Date = new Date(),
): Promise<number> {
  if (!(await getSetting(d.db, 'pipeline.conversations'))) return 0
  const since = new Date(now.getTime() - MAX_AGE_DAYS * 24 * 3600_000).toISOString()
  const res = await d.db.execute(sql`
    select c.id
    from core.conversation c
    join lateral (
      select m.platform_message_id, m.side, m.sent_at
      from core.chat_message m
      where m.conversation_id = c.id and m.side <> 'system'
      order by m.sent_at desc, m.platform_message_id desc
      limit 1
    ) m on true
    where c.closed_at is null and c.owner = 'sara' and m.side = 'client' and m.sent_at >= ${since}
      and c.handled_through is distinct from m.platform_message_id
      and not exists (
        select 1 from core.conv_turn t
        where t.conversation_id = c.id
          and (t.anchor_message_id = m.platform_message_id or jsonb_exists(t.message_ids, m.platform_message_id)))
    order by m.sent_at asc
    limit ${PER_PASS}`)
  let started = 0
  for (const r of res.rows as { id: string }[]) {
    try {
      const conv = await getConversation(d.db, r.id)
      if (!conv) continue
      await (d.start ?? startTurnFor)(conv)
      started++
    } catch (e) {
      console.error(
        'missed turn not started',
        r.id,
        e instanceof Error ? e.message.slice(0, 200) : e,
      )
    }
  }
  return started
}
