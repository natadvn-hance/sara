import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { getSetting } from '../settings/store'
import { getConversation } from './store'
import { INFRA_REASONS, startTurnFor } from './turn'
import type { ConversationRow } from './types'

/** At most this many missed conversations get their turn in one pass, so a catch-up never floods the model. */
const PER_PASS = 5
/** A client word older than this is history, not a missed turn. */
const MAX_AGE_DAYS = 7
/** A turn that met only plumbing trouble is taken again at most this many times, and not sooner than this after it ended. */
const MAX_INFRA_ATTEMPTS = 3
const INFRA_RETRY_AFTER_MIN = 5

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
          and (t.anchor_message_id = m.platform_message_id or jsonb_exists(t.message_ids, m.platform_message_id))
          -- a turn that only met plumbing trouble (an unreadable chat, a planning that threw) did not answer
          and not (t.text is null and t.finished_at is not null and t.decision_reason in (${sql.join(
            INFRA_REASONS.map((r) => sql`${r}`),
            sql`, `,
          )})))
      -- ...but not forever, and not a minute after the last try
      and (select count(*) from core.conv_turn t
           where t.conversation_id = c.id and t.anchor_message_id = m.platform_message_id and t.text is null
             and t.finished_at is not null and t.decision_reason in (${sql.join(
               INFRA_REASONS.map((r) => sql`${r}`),
               sql`, `,
             )})) < ${MAX_INFRA_ATTEMPTS}
      and not exists (
        select 1 from core.conv_turn t
        where t.conversation_id = c.id and t.anchor_message_id = m.platform_message_id
          and (t.finished_at is null or t.finished_at > ${new Date(now.getTime() - INFRA_RETRY_AFTER_MIN * 60_000).toISOString()}))
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

/**
 * The catch-up when the node answers, not before (Boris, 01.11: the core starts together with the node, the first turn met
 * a chat it could not read and the draft was lost): it waits for `ready` (every `everyMs`, up to `tries` times), runs
 * the pass, and then again every `repeatMs`, each time only when the node answers, so a turn cut short by a restart of the
 * node is taken again.
 */
export function startCatchUp(
  d: { db: Db; ready: () => Promise<boolean>; start?: (conv: ConversationRow) => Promise<void> },
  o: { tries?: number; everyMs?: number; repeatMs?: number } = {},
): { stop(): void } {
  let stopped = false
  let running = false
  const pass = async () => {
    if (running || stopped) return
    running = true
    try {
      if (await d.ready().catch(() => false)) await catchUpMissedTurns(d)
    } catch (e) {
      console.error('catch-up of missed turns failed', e instanceof Error ? e.message : e)
    } finally {
      running = false
    }
  }
  void (async () => {
    for (let k = 0; k < (o.tries ?? 20) && !stopped; k++) {
      if (await d.ready().catch(() => false)) break
      await new Promise((r) => setTimeout(r, o.everyMs ?? 15_000))
    }
    await pass()
  })()
  const timer = setInterval(() => void pass(), o.repeatMs ?? 600_000)
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
