import { plural } from '@sara/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { outbox, task } from '../db/schema'
import type { CardState } from '../notify/cardState'
import type { Notifier } from '../notify/notifier'

/**
 * One message to Boris for the whole of a bid (Boris, 31.10.2026): «⏳ Отправляю отклик…» the moment he presses,
 * edited into «✅ Отклик отправлен» and then, when the series is through, into the line about it. No pile of
 * notices: the message is the outbox row's `status` (the Telegram message and the text it shows now).
 */

export type BidStatus = {
  messageId: number
  text: string
  /** The text is Telegram HTML. */
  html?: boolean
  /** The message is the order's own card, folded in place (Boris, 03.11), not a message of its own. */
  card?: boolean
  /** What the card shows when it is a picture (FR-NOTIF-6): the same news as `text`, as its state. */
  state?: CardState
}

type StatusDeps = { db: Db; notifier: Pick<Notifier, 'sendText' | 'editText'> }

let deps: StatusDeps | null = null
export function setBidStatusDeps(x: StatusDeps): void {
  deps = x
}
const d = (): StatusDeps => {
  if (!deps) throw new Error('the bid status is not configured')
  return deps
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The latest bid row of an order, its status message and the task of the card it was pressed on. */
async function rowOf(
  leadId: string,
): Promise<{ id: string; status: BidStatus | null; taskId: string | null } | null> {
  const [row] = await d()
    .db.select({ id: outbox.id, payload: outbox.payload })
    .from(outbox)
    .where(and(eq(outbox.kind, 'bid'), sql`${outbox.payload}->>'leadId' = ${leadId}`))
    .orderBy(desc(outbox.createdAt))
    .limit(1)
  if (!row) return null
  const p = row.payload as { status?: BidStatus; taskId?: string }
  return { id: row.id, status: p.status ?? null, taskId: p.taskId ?? null }
}

/** What the order's status message is now, if there is one (read before a give-back deletes the row). */
export async function statusOf(leadId: string): Promise<BidStatus | null> {
  return (await rowOf(leadId))?.status ?? null
}

async function store(id: string, status: BidStatus): Promise<void> {
  await d()
    .db.update(outbox)
    .set({ payload: sql`${outbox.payload} || ${JSON.stringify({ status })}::jsonb` })
    .where(eq(outbox.id, id))
}

/**
 * The status message at the press; once per bid row (a second call finds it and does nothing). With `fold` the card
 * Boris pressed on is the message: it is edited into `text` (HTML) without its buttons, and no message of its own is
 * sent; a card that is not known, or that Telegram will not edit, gets a message of its own as before.
 */
export async function openStatus(
  leadId: string,
  text: string,
  o: { fold?: boolean; state?: CardState } = {},
): Promise<void> {
  const row = await rowOf(leadId)
  if (!row || row.status) return
  const edit = d().notifier.editText
  if (o.fold && row.taskId && edit) {
    const [t] = await d()
      .db.select({ messageId: task.telegramMessageId })
      .from(task)
      .where(eq(task.id, row.taskId))
    if (t?.messageId != null) {
      const folded = await edit
        .call(d().notifier, t.messageId, text, [], { html: true, state: o.state })
        .then(() => true)
        .catch(() => false)
      if (folded)
        return store(row.id, {
          messageId: t.messageId,
          text,
          html: true,
          card: true,
          ...(o.state && { state: o.state }),
        })
    }
  }
  const { messageId } = await d().notifier.sendText(text, {
    place: 'leads',
    ...(o.fold && { html: true }),
  })
  await store(row.id, { messageId, text, ...(o.fold && { html: true }) })
}

/**
 * The status message shows `text` now; false when there is none (the caller says it in a message of its own). An edit
 * Telegram will not take (a limit, a deleted message) is no loss of the news: it goes as a short message of its own.
 * The same text again is no edit at all.
 */
export async function setStatus(
  leadId: string,
  text: string,
  o: { html?: boolean; state?: CardState } = {},
): Promise<boolean> {
  const row = await rowOf(leadId)
  const edit = d().notifier.editText
  if (!row?.status || !edit) return false
  const html = o.html ?? row.status.html ?? false
  try {
    await edit.call(d().notifier, row.status.messageId, text, row.status.card ? [] : undefined, {
      html,
      state: o.state,
    })
    // A text without a state is the picture's note now, so a line added later goes under that text.
    await store(row.id, { ...row.status, text, html, state: o.state })
  } catch {
    const { messageId } = await d().notifier.sendText(text, {
      place: 'leads',
      ...(html && { html }),
    })
    await store(row.id, { messageId, text, html })
  }
  return true
}

/** A line under what the status message says (how the series went). */
export async function addStatusLine(leadId: string, line: string): Promise<void> {
  const row = await rowOf(leadId)
  if (!row?.status) return
  const w = row.status.state
  await setStatus(leadId, `${row.status.text}\n${row.status.html ? esc(line) : line}`, {
    ...(row.status.html && { html: true }),
    ...(w && { state: { ...w, n: w.n ? `${w.n}\n${line}` : line } }),
  })
}

const STOPPED: Record<string, string> = {
  client_replied: 'клиент уже ответил, дальше отвечу по разговору',
  boris_wrote: 'в чате есть чужое сообщение, смотри разговор',
  boris_leads: 'клиента ведешь ты',
  not_now: 'отправка писем клиентам на паузе или не разрешена',
  no_slots: 'нет свободного времени для созвона',
  not_sent: 'письмо не ушло',
}

/** The line of the status message about the series: how many went, and why it stopped when it did. */
export function seriesLine(sent: number, why?: string, total?: number): string {
  const went =
    sent > 0 ? `Вдогонку ушло ${sent} ${plural(sent, ['сообщение', 'сообщения', 'сообщений'])}` : ''
  if (!why) return went
  const left = total === undefined ? 0 : total - sent
  const stop =
    why === 'not_sent' && left > 0
      ? `Вдогонку не ушло ${left} из ${total} писем: площадка не ответила, письма в чате нет`
      : `Вдогонку остановилась: ${STOPPED[why] ?? why}`
  return sent > 0 ? `${went}. ${stop}` : stop
}
