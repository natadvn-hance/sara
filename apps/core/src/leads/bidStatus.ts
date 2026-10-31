import { plural } from '@sara/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { outbox } from '../db/schema'
import type { Notifier } from '../notify/notifier'

/**
 * One message to Boris for the whole of a bid (Boris, 31.10.2026): «⏳ Отправляю отклик…» the moment he presses,
 * edited into «✅ Отклик отправлен» and then, when the series is through, into the line about it. No pile of
 * notices: the message is the outbox row's `status` (the Telegram message and the text it shows now).
 */

export type BidStatus = { messageId: number; text: string }

type StatusDeps = { db: Db; notifier: Pick<Notifier, 'sendText' | 'editText'> }

let deps: StatusDeps | null = null
export function setBidStatusDeps(x: StatusDeps): void {
  deps = x
}
const d = (): StatusDeps => {
  if (!deps) throw new Error('the bid status is not configured')
  return deps
}

/** The latest bid row of an order and its status message, if any. */
async function rowOf(leadId: string): Promise<{ id: string; status: BidStatus | null } | null> {
  const [row] = await d()
    .db.select({ id: outbox.id, payload: outbox.payload })
    .from(outbox)
    .where(and(eq(outbox.kind, 'bid'), sql`${outbox.payload}->>'leadId' = ${leadId}`))
    .orderBy(desc(outbox.createdAt))
    .limit(1)
  if (!row) return null
  const status = (row.payload as { status?: BidStatus }).status
  return { id: row.id, status: status ?? null }
}

async function store(id: string, status: BidStatus): Promise<void> {
  await d()
    .db.update(outbox)
    .set({ payload: sql`${outbox.payload} || ${JSON.stringify({ status })}::jsonb` })
    .where(eq(outbox.id, id))
}

/** The status message at the press; once per bid row (a second call finds it and does nothing). */
export async function openStatus(leadId: string, text: string): Promise<void> {
  const row = await rowOf(leadId)
  if (!row || row.status) return
  const { messageId } = await d().notifier.sendText(text, { place: 'leads' })
  await store(row.id, { messageId, text })
}

/**
 * The status message shows `text` now; false when there is none (the caller says it in a message of its own). An edit
 * Telegram refuses (the same text, a deleted message) is no failure: the text is kept all the same.
 */
export async function setStatus(leadId: string, text: string): Promise<boolean> {
  const row = await rowOf(leadId)
  const edit = d().notifier.editText
  if (!row?.status || !edit) return false
  await edit.call(d().notifier, row.status.messageId, text).catch(() => {})
  await store(row.id, { messageId: row.status.messageId, text })
  return true
}

/** A line under what the status message says (how the series went). */
export async function addStatusLine(leadId: string, line: string): Promise<void> {
  const row = await rowOf(leadId)
  if (!row?.status) return
  await setStatus(leadId, `${row.status.text}\n${line}`)
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
export function seriesLine(sent: number, why?: string): string {
  const went =
    sent > 0 ? `Вдогонку ушло ${sent} ${plural(sent, ['сообщение', 'сообщения', 'сообщений'])}` : ''
  if (!why) return went
  const stop = `Вдогонку остановилась: ${STOPPED[why] ?? why}`
  return sent > 0 ? `${went}. ${stop}` : stop
}
