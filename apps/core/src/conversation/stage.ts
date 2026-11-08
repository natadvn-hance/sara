import { newEventId } from '@sara/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { deal, jobRun } from '../db/schema'
import { advanceTo, type DealStage } from '../domain/deal'
import type { ConversationRow } from './types'

/**
 * The stage of a deal moves on the events (Boris, 01.11: «клиент ответил, а это значит что круг должен стать
 * светло-зелёным … это автоматический процесс, который должен происходить каждый раз при смене статуса»). The deal is
 * the one place the stage lives in; the topic, the sheet, the pult and the analytics read it from there.
 *
 * Moves by events:
 * - the client's first word: bid_sent -> talking (here); a dormant deal wakes the same way (reminders.ts did it already);
 * - a meeting Boris records: -> call_booked, and its held outcome -> call_done (pult/clients.ts);
 * - Boris's outcome: won or lost (pult/clients.ts), his closing of the conversation: lost (commands.ts);
 * - a client silent after the reminders: dormant (reminderSteps.ts).
 * Not by an event Sara can read reliably: talking -> call_proposed (what makes a call offer, answered or not) and the
 * agreement on a call in the chat before Boris writes the meeting down.
 */

const STAGES_BEFORE_TALK: readonly string[] = ['found', 'queued', 'bid_sent', 'dormant']

/** The deal of a conversation: the one it was made with, else the one of its order. */
export async function dealOf(db: DbOrTx, conv: Pick<ConversationRow, 'dealId' | 'orderId'>) {
  if (conv.dealId) {
    const [d] = await db.select().from(deal).where(eq(deal.id, conv.dealId))
    if (d) return d
  }
  if (!conv.orderId) return null
  const [d] = await db.select().from(deal).where(eq(deal.leadId, conv.orderId))
  return d ?? null
}

/** A client wrote: a deal that waited for it goes on to talking. Never throws: the reading of the chat comes first. */
export async function promoteOnClientWord(
  db: Db,
  conv: Pick<ConversationRow, 'id' | 'dealId' | 'orderId'>,
): Promise<boolean> {
  try {
    const d = await dealOf(db, conv)
    if (!d || !STAGES_BEFORE_TALK.includes(d.stage)) return false
    return await advanceTo(db, {
      dealId: d.id,
      to: 'talking',
      actor: 'client',
      reason: 'клиент ответил',
      correlationId: conv.id,
    })
  } catch (e) {
    console.error('deal not moved on the client word', e instanceof Error ? e.message : e)
    return false
  }
}

const BACKFILL_JOB = 'deals_talking_backfill'

/**
 * Once: the deals that went on without a stage change (the move did not exist) and whose chat holds a client's word
 * become talking. Nothing goes to any client. A mark in job_run keeps it from repeating after a restart.
 */
export async function backfillTalking(db: Db): Promise<number> {
  const taken = await db
    .insert(jobRun)
    .values({ name: BACKFILL_JOB, day: '2000-01-01' })
    .onConflictDoNothing()
    .returning({ day: jobRun.day })
  if (taken.length === 0) return 0
  const rows = await db.execute(sql`
    select d.id as deal_id, c.id as conv_id
    from core.deal d
    join core.conversation c on c.deal_id = d.id or c.order_id = d.lead_id
    where d.stage in ('bid_sent', 'dormant')
      and exists (select 1 from core.chat_message m where m.conversation_id = c.id and m.side = 'client')
    group by d.id, c.id`)
  let moved = 0
  for (const r of rows.rows as { deal_id: string; conv_id: string }[]) {
    try {
      if (
        await advanceTo(db, {
          dealId: r.deal_id,
          to: 'talking',
          actor: 'sara',
          reason: 'клиент уже отвечал, этап поправлен разовым проходом',
          correlationId: r.conv_id ?? newEventId(),
        })
      )
        moved++
    } catch (e) {
      console.error('deal not moved by the pass', r.deal_id, e instanceof Error ? e.message : e)
    }
  }
  return moved
}

/** The stage a deal is in, for whoever needs the raw one. */
export async function dealStageOf(db: Db, dealId: string): Promise<DealStage | null> {
  const [d] = await db
    .select({ stage: deal.stage })
    .from(deal)
    .where(and(eq(deal.id, dealId)))
  return (d?.stage as DealStage | undefined) ?? null
}
