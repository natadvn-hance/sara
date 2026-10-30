import { DBOS } from '@dbos-inc/dbos-sdk'
import { TEST_ORDER_SQL } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'

// A constant pattern, written into the statements: several statements in one call may carry no parameters.
const R = sql.raw(`'${TEST_ORDER_SQL}'`)

/**
 * Erases every test order and all that grew from it (docs/ops/test-leads.md): leads, scores, cards and their tasks,
 * bids and messages in the outbox, conversations and their turns, questions, and the durable processes still waiting
 * for them. The journal stays as it is (append-only, rule of the data dictionary): its lines about test orders carry
 * their test numbers, and every count leaves them out. Real orders are never touched: every row is picked by a test
 * number or by a row that is. Returns how many test orders were erased.
 */
export async function wipeTestOrders(db: Db): Promise<number> {
  const tokens: string[] = []
  const erased = await db.transaction(async (tx) => {
    await tx.execute(sql`
      create temp table t_conv on commit drop as
        select id from core.conversation where chat_id ~ ${R} or coalesce(order_id, '') ~ ${R};
      create temp table t_turn on commit drop as
        select id, task_id from core.conv_turn where conversation_id in (select id from t_conv);
      create temp table t_task on commit drop as
        select id from core.task
        where (entity_kind = 'lead' and entity_id ~ ${R})
          or (entity_kind = 'conv_turn' and entity_id in (select id::text from t_turn))
          or id in (select task_id from t_turn where task_id is not null);
      create temp table t_outbox on commit drop as
        select id from core.outbox
        where coalesce(payload->>'leadId', '') ~ ${R} or coalesce(payload->>'chatId', '') ~ ${R}`)
    const ids = await tx.execute<{ id: string }>(sql`
      select id from core.lead where id ~ ${R}
      union all select id::text from t_conv union all select id::text from t_turn
      union all select id::text from t_task union all select id::text from t_outbox`)
    tokens.push(...ids.rows.map((r) => r.id))
    const leads = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from core.lead where id ~ ${R}`,
    )
    await tx.execute(sql`
      delete from core.question where entity_id ~ ${R} or entity_id in (select id::text from t_task);
      delete from core.mind_gap where turn_id in (select id::text from t_turn);
      delete from core.chat_message where chat_id ~ ${R} or conversation_id in (select id from t_conv);
      delete from core.conv_turn where id in (select id from t_turn);
      delete from core.conversation where id in (select id from t_conv);
      delete from core.task where id in (select id from t_task);
      delete from core.outbox where id in (select id from t_outbox);
      delete from core.deal where lead_id ~ ${R};
      delete from core.lead_score where lead_id ~ ${R};
      delete from core.lead_label where lead_id ~ ${R};
      delete from core.lead_route where order_id ~ ${R};
      delete from core.lead_candidate where order_id ~ ${R};
      delete from core.lead where id ~ ${R}`)
    return leads.rows[0]?.n ?? 0
  })
  // The processes still waiting for those rows (a series, a reminder, a turn) would wake up to nothing: they stop now.
  const waiting = await DBOS.listWorkflows({ status: ['PENDING', 'ENQUEUED'] }).catch(() => [])
  const stale = waiting.map((w) => w.workflowID).filter((id) => tokens.some((t) => id.includes(t)))
  if (stale.length > 0) await DBOS.cancelWorkflows(stale).catch(() => {})
  return erased
}
