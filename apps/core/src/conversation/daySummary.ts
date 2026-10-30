import { newEventId, plural } from '@sara/shared'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { convTurn, jobRun } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { mskParts } from '../learning/summary'
import type { Notifier } from '../notify/notifier'
import { NOT_TEST } from '../testLeads/sql'
import { moscowDayStart } from './cards'
import { turnStats } from './report'
import { moscowHour } from './time'

/** The evening conversation summary comes at 20:00 Moscow, an hour after the leads' one (M4 design 5.12). */
const SUMMARY_HOUR = 20

/**
 * «Разговоры за день» (FR-NOTIF-3): one message an evening, only for a day with turns. A day without turns does
 * not take the day's place, so a turn later that evening still gets it.
 */
export async function daySummary(
  d: { db: Db; notifier: Pick<Notifier, 'sendText'> },
  now: Date = new Date(),
): Promise<'not_yet' | 'empty' | 'already' | 'sent'> {
  if (moscowHour(now) < SUMMARY_HOUR) return 'not_yet'
  const from = moscowDayStart(now)
  const to = new Date(new Date(from).getTime() + 24 * 3600_000).toISOString()
  const rows = await d.db
    .select()
    .from(convTurn)
    .where(
      and(
        gte(convTurn.createdAt, from),
        lt(convTurn.createdAt, to),
        // Only the answers to client turns: a reminder's draft is in the report, not in the evening summary.
        eq(convTurn.kind, 'reply'),
        // Test chats are no work of the day (docs/ops/test-leads.md).
        sql`exists (select 1 from core.conversation c where c.id = ${convTurn.conversationId} and ${NOT_TEST('c.chat_id')})`,
      ),
    )
  if (rows.length === 0) return 'empty'
  const taken = await d.db
    .insert(jobRun)
    .values({ name: 'conv_day_summary', day: mskParts(now).day })
    .onConflictDoNothing()
    .returning({ day: jobRun.day })
  if (taken.length === 0) return 'already'
  const s = turnStats(rows)
  const drafts = s.drafted + s.called
  const lines = [
    `🗒️ Разговоры за день: ${s.turns} ${plural(s.turns, ['реплика клиента', 'реплики клиентов', 'реплик клиентов'])}, ${drafts} ${plural(drafts, ['черновик', 'черновика', 'черновиков'])}, карточкой пришло ${s.cards}.`,
  ]
  if (s.turns > s.cards)
    lines.push(`Без карточки осталось ${s.turns - s.cards}: они в отчёте report:conv.`)
  if (s.compared.length)
    lines.push(
      `Сравнила с тем, что ушло клиентам: ${s.compared.length}, среднее сходство ${s.avg ?? 0}%.`,
    )
  await d.notifier.sendText(lines.join('\n'))
  await appendEvent(d.db, {
    type: 'conv.day_summary',
    v: 1,
    entity: { kind: 'job', id: 'conv_day_summary' },
    account_id: null,
    actor: 'sara',
    occurred_at: now.toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { turns: s.turns, cards: s.cards, compared: s.compared.length },
  })
  return 'sent'
}

/** Checks every `tickMs` whether the evening summary is due. */
export function startConvDaySummary(
  d: { db: Db; notifier: Pick<Notifier, 'sendText'> },
  tickMs = 60_000,
): { stop(): void } {
  const timer = setInterval(() => {
    void daySummary(d).catch((e) =>
      console.error('conversation summary failed', e instanceof Error ? e.message : e),
    )
  }, tickMs)
  return { stop: () => clearInterval(timer) }
}
