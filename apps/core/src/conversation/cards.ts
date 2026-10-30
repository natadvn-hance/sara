import { formatCallback, newEventId, shownTitle, type TaskAction, type Tone } from '@sara/shared'
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { chatMessage, convTurn, lead, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { Notifier } from '../notify/notifier'
import { getSetting } from '../settings/store'
import { getConversation } from './store'
import { type CardView, CONV_TEXTS } from './texts'
import { inMoscowHours } from './time'

export type CardDeps = { db: Db; notifier: Pick<Notifier, 'sendButtons' | 'editText'> }

/** The start of the Moscow day `now` is in, as an ISO string (UTC+3 all year). */
export function moscowDayStart(now: Date): string {
  const shifted = new Date(now.getTime() + 3 * 3600_000)
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 3 * 3600_000,
  ).toISOString()
}

type Row = typeof convTurn.$inferSelect

/** Everything a card shows about a turn, from the trace row, its conversation and its client messages. */
export async function cardView(db: Db, t: Row): Promise<CardView> {
  const conv = await getConversation(db, t.conversationId)
  const [l] = conv?.orderId ? await db.select().from(lead).where(eq(lead.id, conv.orderId)) : []
  const ids = (t.messageIds as string[]) ?? []
  const words = ids.length
    ? await db
        .select({ text: chatMessage.text, id: chatMessage.platformMessageId })
        .from(chatMessage)
        .where(
          and(
            eq(chatMessage.conversationId, t.conversationId),
            inArray(chatMessage.platformMessageId, ids),
          ),
        )
    : []
  const byId = new Map(words.map((w) => [w.id, w.text]))
  const understanding =
    (t.understanding as {
      tone?: Tone
      would?: string
      case?: { case_id?: string | null; why?: string | null; title?: string } | null
    } | null) ?? null
  const told = understanding?.case
  return {
    name: l?.clientName || null,
    orderTitle: l ? shownTitle(l.id, l.title) : null,
    clientWords: ids
      .map((id) => byId.get(id) ?? '')
      .filter(Boolean)
      .join('\n'),
    text: t.text,
    decision: t.decision,
    reason: t.decisionReason,
    shadow: await getSetting(db, 'conv.v1_writes'),
    tone: understanding?.tone ?? null,
    factIds: (t.factIds as string[]) ?? [],
    examples: ((t.exampleIds as string[]) ?? []).length,
    caseUsed: told?.case_id ? { title: told.title || told.case_id, why: told.why ?? null } : null,
    callsBoris: t.decision === 'call_boris' || understanding?.would === 'call_boris',
    issues: ((t.checks as { issues?: { detail: string }[] } | null)?.issues ?? []).map(
      (x) => x.detail,
    ),
  }
}

function rowsFor(
  taskId: string,
  t: Row,
  shadow: boolean,
): { text: string; callbackData: string }[][] {
  const b = CONV_TEXTS.buttons
  const btn = (text: string, action: TaskAction) => ({
    text,
    callbackData: formatCallback(taskId, action),
  })
  const first =
    t.decision === 'call_boris'
      ? // A draft meant for Boris: after the switch he can send it with the button he uses for drafts.
        !shadow && t.text
        ? [btn(b.send, 'send'), btn(b.edit, 'edit')]
        : [btn(b.edit, 'edit')]
      : shadow
        ? [btn(b.good, 'good'), btn(b.edit, 'edit')]
        : [btn(b.send, 'send'), btn(b.edit, 'edit')]
  return [first, [btn(b.take, 'take'), btn(b.close, 'close')]]
}

/**
 * The card of a decided turn (M4 design 5.12): the shadow draft, a draft for Boris's «да», or a call for him. In
 * shadow at most conv.cards_per_day draft cards a Moscow day; a call for Boris always goes; at quiet hours without a
 * sound. After the switch no card is held back: a draft card is the client's only way to an answer (FR-NOTIF-3).
 * Null when the day's shadow cards are used up (the turn stays in the trace and in the evening summary).
 */
export async function sendTurnCard(
  d: CardDeps,
  turnId: string,
): Promise<{ taskId: string; messageId: number } | null> {
  const [t] = await d.db.select().from(convTurn).where(eq(convTurn.id, turnId))
  if (!t) return null
  if (t.cardMessageId !== null && t.taskId) return { taskId: t.taskId, messageId: t.cardMessageId }
  const now = new Date()
  const urgent = t.decision === 'call_boris'
  // The cap is for shadow, where the cards only teach. After the switch they are the answers to clients.
  if (!urgent && (await getSetting(d.db, 'conv.v1_writes'))) {
    const [c] = await d.db
      .select({ n: sql<number>`count(*)::int` })
      .from(convTurn)
      .where(
        and(
          // The cards of answers to clients only: the task of a quiet client (a reminder's row) is no draft card.
          eq(convTurn.kind, 'reply'),
          isNotNull(convTurn.cardMessageId),
          ne(convTurn.decision, 'call_boris'),
          gte(convTurn.createdAt, moscowDayStart(now)),
        ),
      )
    if ((c?.n ?? 0) >= (await getSetting(d.db, 'conv.cards_per_day'))) return null
  }
  const view = await cardView(d.db, t)
  const taskId = newEventId()
  // At quiet hours the Telegram layer sends it without sound (FR-NOTIF-2, cards.quiet_hours).
  const m = await d.notifier.sendButtons(CONV_TEXTS.card(view), rowsFor(taskId, t, view.shadow))
  await d.db.transaction(async (tx) => {
    await tx.insert(task).values({
      id: taskId,
      kind: 'conv_draft',
      entityKind: 'conv_turn',
      entityId: turnId,
      priority: urgent ? 'P0' : 'P1',
      telegramMessageId: m.messageId,
    })
    await tx
      .update(convTurn)
      .set({ taskId, cardMessageId: m.messageId })
      .where(eq(convTurn.id, turnId))
    await appendEvent(tx, {
      type: 'task.created',
      v: 1,
      entity: { kind: 'task', id: taskId },
      account_id: null,
      actor: 'sara',
      occurred_at: now.toISOString(),
      causation_id: null,
      correlation_id: t.conversationId,
      reason: null,
      payload: { kind: 'conv_draft', turn_id: turnId },
    })
  })
  return { taskId, messageId: m.messageId }
}

/** The card again with the rows it had (none when `buttons` is false): used when its text grows (the comparison). */
export async function redrawCard(
  d: CardDeps,
  t: Row,
  tail: string,
  o: { buttons?: boolean } = {},
): Promise<void> {
  if (t.cardMessageId === null || !t.taskId) return
  const view = await cardView(d.db, t)
  await d.notifier.editText?.(
    t.cardMessageId,
    `${CONV_TEXTS.card(view)}\n\n${tail}`,
    o.buttons === false ? [] : rowsFor(t.taskId, t, view.shadow),
  )
}

/**
 * The words of a client Boris leads, or of a closed conversation, go to him (FR-NOTIF-1 «Клиент написал») with
 * «Вернуть Саре». Only after the switch: in shadow old Sara still tells him herself.
 */
export async function forwardTurn(
  d: CardDeps & { notifier: Pick<Notifier, 'sendButtons'> },
  turnId: string,
) {
  if (await getSetting(d.db, 'conv.v1_writes')) return
  const [t] = await d.db.select().from(convTurn).where(eq(convTurn.id, turnId))
  if (!t || t.cardMessageId !== null) return
  const conv = await getConversation(d.db, t.conversationId)
  const view = await cardView(d.db, t)
  const words =
    view.clientWords ||
    (
      await d.db
        .select({ text: chatMessage.text })
        .from(chatMessage)
        .where(
          and(eq(chatMessage.conversationId, t.conversationId), eq(chatMessage.side, 'client')),
        )
        .orderBy(desc(chatMessage.sentAt))
        .limit(1)
    )[0]?.text ||
    ''
  const taskId = newEventId()
  const m = await d.notifier.sendButtons(
    CONV_TEXTS.forward(view.name, view.orderTitle, words, conv?.closedAt !== null),
    [[{ text: CONV_TEXTS.buttons.giveBack, callbackData: formatCallback(taskId, 'return') }]],
  )
  await d.db.insert(task).values({
    id: taskId,
    kind: 'conv_draft',
    entityKind: 'conv_turn',
    entityId: turnId,
    priority: 'P1',
    telegramMessageId: m.messageId,
  })
  await d.db
    .update(convTurn)
    .set({ taskId, cardMessageId: m.messageId })
    .where(eq(convTurn.id, turnId))
}
