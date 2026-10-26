import { formatCallback, newEventId, type TaskAction } from '@sara/shared'
import { and, eq, like } from 'drizzle-orm'
import type { Db } from '../db/client'
import { convTurn, lead, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { Notifier } from '../notify/notifier'
import { SEND_TEXTS } from './outbox'
import type { Ground } from './reminderSteps'
import { getConversation } from './store'
import { CONV_TEXTS, REMIND_TEXTS } from './texts'
import type { ConversationRow } from './types'

/**
 * The card of a reminder in drafts mode (FR-CONV-12, FR-CONV-5): after the switch with the autopilot off the reminder
 * is not queued, Boris gets «Напомнить клиенту?» with «Отправить», «Изменить» and «Не надо», and the text goes only on
 * his press, through the same path as the text of a draft card. The trace row of the reminder step holds the card and,
 * later, the press: `carded` → `sent` | `declined` | `stopped` | `expired` | ….
 */

type Row = typeof convTurn.$inferSelect
type CardTask = typeof task.$inferSelect

/** The step of the ladder a card is for (the dormant day is no message to the client). */
type CardStep = 1 | 2 | 3

export type ReminderCardDeps = { db: Db; notifier: Pick<Notifier, 'sendButtons'> }

/** What a press needs: the way to send a text now and the reread of the chat that decides whether it still may go. */
export type ReminderPressDeps = {
  db: Db
  sendText?(
    conversationId: string,
    text: string,
    author: 'sara' | 'boris',
    o?: { expectLast?: string | null; key?: string },
  ): Promise<string>
  remindGround?(conversationId: string, anchor: string): Promise<Ground>
}

/** The reminder rows of a conversation whose card still waits for Boris are no longer meant when a newer one comes. */
async function expireOldCards(db: Db, conversationId: string, keepRowId: string): Promise<void> {
  const open = await db
    .select({ id: task.id, rowId: task.entityId })
    .from(task)
    .where(
      and(
        eq(task.kind, 'conv_draft'),
        like(task.entityId, `conv-remind:${conversationId}:%`),
        eq(task.state, 'open'),
      ),
    )
  for (const o of open) {
    if (o.rowId === keepRowId) continue
    await closeCard(db, o.id, 'expired')
    await db
      .update(convTurn)
      .set({ outcome: 'expired', decisionReason: 'пришло следующее напоминание' })
      .where(and(eq(convTurn.id, o.rowId), eq(convTurn.outcome, 'carded')))
  }
}

/** The card's task is resolved once; false when it already was. */
async function closeCard(db: Db, taskId: string, resolution: string): Promise<boolean> {
  const rows = await db
    .update(task)
    .set({ state: 'resolved', resolution, resolvedAt: new Date().toISOString() })
    .where(and(eq(task.id, taskId), eq(task.state, 'open')))
    .returning({ id: task.id })
  return rows.length > 0
}

/** Boris's task for the reminder step `rowId`, once: the Telegram card, its task and the row that points at both. */
export async function sendReminderCard(
  d: ReminderCardDeps,
  rowId: string,
  conv: ConversationRow,
  step: CardStep,
  text: string,
): Promise<{ taskId: string; messageId: number }> {
  await expireOldCards(d.db, conv.id, rowId)
  const [l] = conv.orderId ? await d.db.select().from(lead).where(eq(lead.id, conv.orderId)) : []
  const taskId = newEventId()
  const button = (label: string, action: TaskAction) => ({
    text: label,
    callbackData: formatCallback(taskId, action),
  })
  const b = CONV_TEXTS.buttons
  const m = await d.notifier.sendButtons(
    CONV_TEXTS.reminderCard({
      name: l?.clientName || null,
      orderTitle: l?.title ?? null,
      step,
      text,
    }),
    [[button(b.send, 'send'), button(b.edit, 'edit'), button(b.skip, 'skip')]],
  )
  await d.db.transaction(async (tx) => {
    await tx.insert(task).values({
      id: taskId,
      kind: 'conv_draft',
      entityKind: 'conv_turn',
      entityId: rowId,
      priority: 'P1',
      telegramMessageId: m.messageId,
    })
    await tx
      .update(convTurn)
      .set({ taskId, cardMessageId: m.messageId })
      .where(eq(convTurn.id, rowId))
    await appendEvent(tx, {
      type: 'task.created',
      v: 1,
      entity: { kind: 'task', id: taskId },
      account_id: null,
      actor: 'sara',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: conv.id,
      reason: null,
      payload: { kind: 'conv_draft', turn_id: rowId },
    })
  })
  return { taskId, messageId: m.messageId }
}

async function journalSent(d: { db: Db }, row: Row) {
  const conv = await getConversation(d.db, row.conversationId)
  if (!conv) return
  await appendEvent(d.db, {
    type: 'conv.reminder_sent',
    v: 1,
    entity: { kind: 'conv_turn', id: row.id },
    account_id: conv.accountId,
    actor: 'boris',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: conv.id,
    reason: null,
    // Numbers and labels only, never a client's words (ADR-022).
    payload: {
      conversation_id: conv.id,
      step: (row.understanding as { step?: number | string } | null)?.step ?? null,
      by_press: true,
    },
  })
}

/** The row's outcome moves from one value to the next once: false when somebody else moved it first. */
async function move(db: Db, rowId: string, from: string, patch: Partial<Row>): Promise<boolean> {
  const rows = await db
    .update(convTurn)
    .set(patch)
    .where(and(eq(convTurn.id, rowId), eq(convTurn.outcome, from)))
    .returning({ id: convTurn.id })
  return rows.length > 0
}

/**
 * Boris's text goes to the client from the card of a reminder, once: the chat is read again first (a client who wrote,
 * our side who wrote, a pause: nothing goes), the card and the row are taken by one press, and the service is told
 * the last message the reread saw (CHAT_CHANGED if the chat moved on meanwhile). `how` is the card's resolution:
 * `send` for «Отправить» (Sara's text, queueMessage knows the key), `edit` for his own text.
 */
async function release(
  d: ReminderPressDeps,
  t: CardTask,
  row: Row,
  o: { text: string; author: 'sara' | 'boris'; key: string; how: 'send' | 'edit' },
): Promise<string> {
  if (t.state !== 'open' || row.outcome !== 'carded') return REMIND_TEXTS.alreadyDone
  if (!d.sendText || !d.remindGround) return REMIND_TEXTS.notNow('не могу проверить чат')
  const g = await d.remindGround(row.conversationId, row.anchorMessageId)
  if (!g.go) {
    if (!g.end) return REMIND_TEXTS.notNow(g.why)
    // The ladder is over for this client (he wrote, Boris wrote, the chat was closed): this card is moot.
    await closeCard(d.db, t.id, 'stale')
    await move(d.db, row.id, 'carded', {
      outcome: 'stopped',
      decision: 'nothing',
      decisionReason: g.why,
    })
    return REMIND_TEXTS.gone(g.why)
  }
  // One press takes the card, and the row is taken once however many cards point at it.
  if (!(await closeCard(d.db, t.id, o.how))) return REMIND_TEXTS.alreadyDone
  if (!(await move(d.db, row.id, 'carded', { outcome: 'sending' }))) return REMIND_TEXTS.alreadyDone
  const answer = await d.sendText(row.conversationId, o.text, o.author, {
    expectLast: g.lastId ?? undefined,
    key: o.key,
  })
  const by = o.how === 'send' ? 'по нажатию Бориса' : 'с текстом Бориса'
  if (answer === SEND_TEXTS.sent) {
    await move(d.db, row.id, 'sending', {
      outcome: 'sent',
      decision: 'send',
      decisionReason: `ушло клиенту ${by}`,
    })
    await journalSent(d, row)
    return REMIND_TEXTS.sent
  }
  if (answer === SEND_TEXTS.changed) {
    await d.db.update(task).set({ resolution: 'stale' }).where(eq(task.id, t.id))
    await move(d.db, row.id, 'sending', {
      outcome: 'stopped',
      decision: 'nothing',
      decisionReason: 'в чате появилось новое: служба не дала написать',
    })
    return REMIND_TEXTS.stale
  }
  const uncertain = answer === SEND_TEXTS.uncertain
  await move(d.db, row.id, 'sending', {
    outcome: uncertain ? 'uncertain' : 'failed',
    decision: 'send',
    decisionReason: uncertain ? 'не уверена, что дошло' : 'не смогла отправить',
  })
  return answer
}

/** A press on the card of a reminder: «Отправить» or «Не надо» (the «Изменить» question is asked by the caller). */
export async function onReminderPress(
  d: ReminderPressDeps,
  t: CardTask,
  row: Row,
  action: TaskAction,
): Promise<string> {
  if (action === 'send') {
    if (!row.text) return REMIND_TEXTS.alreadyDone
    return release(d, t, row, {
      text: row.text,
      author: 'sara',
      key: `send:${t.id}`,
      how: 'send',
    })
  }
  if (action === 'skip') {
    if (!(await closeCard(d.db, t.id, 'skip'))) return REMIND_TEXTS.alreadyDone
    await move(d.db, row.id, 'carded', {
      outcome: 'declined',
      decision: 'nothing',
      decisionReason: 'Борис: не надо',
    })
    return REMIND_TEXTS.declined
  }
  return REMIND_TEXTS.alreadyDone
}

/** Boris's own version of a reminder, after «Изменить»: it goes as his text, once, through the same reread. */
export async function editReminder(
  d: ReminderPressDeps,
  row: Row,
  text: string,
  key: string | undefined,
): Promise<string> {
  const [t] = row.taskId ? await d.db.select().from(task).where(eq(task.id, row.taskId)) : []
  if (!t) return REMIND_TEXTS.alreadyDone
  return release(d, t, row, {
    text,
    author: 'boris',
    key: key ?? `say:${newEventId()}`,
    how: 'edit',
  })
}
