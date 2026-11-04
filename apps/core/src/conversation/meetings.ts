import { newEventId } from '@sara/shared'
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { chatMessage, meeting } from '../db/schema'
import { advanceTo } from '../domain/deal'
import type { Gateway } from '../gateway/gateway'
import { appendEvent } from '../journal/journal'
import { markShown } from '../notify/forum'
import { type MeetingCardView, meetingCard } from '../notify/meetingCard'
import type { Notifier } from '../notify/notifier'
import { getSetting } from '../settings/store'
import { clientNames } from './dossier'
import { dealOf } from './stage'
import type { ConversationRow, StoredMessage } from './types'

/**
 * A call booked in the chat is known to Sara (Boris, 03.11: «сара сама не понимает когда была назначена встреча, даже
 * если все признаки в переписке указывают на это. Она продолжает напоминать после того как договорились»). On a new
 * message, whoever wrote it, Boris included, the code first asks whether the last words are about a call at all (words
 * of a call, a time, a phone), and only then a short call to a cheap role reads them. A firm agreement moves the deal to
 * the booked call, writes the meeting (which takes the slot from other clients) and puts a card, pinned and edited in
 * place, into the client's topic. «Похоже, договорились» is only a note on the card: no stage, no slot. Offering times
 * is no agreement. While a meeting stands, no reminder goes and nothing is «waiting for an answer».
 */

const STATUS = ['booked', 'maybe', 'rescheduled', 'cancelled', 'proposed', 'none'] as const
export const MeetingRead = z.object({
  status: z.enum(STATUS),
  at: z.string().nullable().optional(),
  how: z.enum(['phone', 'telegram', 'video', 'unknown']).nullable().optional(),
  caller: z.enum(['we', 'client', 'unknown']).nullable().optional(),
  quote: z.string().nullable().optional(),
})
export type MeetingRead = z.infer<typeof MeetingRead>

const WORDS =
  /созвон|позвон|звон(ок|ить|ю|им)|набер|набра|трубк|встреч|свяж|голос|zoom|зум|мит\b|телемост|google\s?meet/iu
const TIME =
  /\b\d{1,2}\s?[:.]\s?\d{2}\b|\bв\s\d{1,2}\b|завтра|послезавтра|сегодня|понедельник|вторник|сред[уы]|четверг|пятниц|суббот|воскресень|утром|днём|днем|вечером|после обеда/iu
const PHONE = /(?:\+7|\b8)[\s\-()]*\d[\d\s\-()]{8,}/u

/** The cheap gate: the last words speak of a call, with a time or a number. */
export function looksLikeMeeting(texts: string[]): boolean {
  const all = texts.join('\n')
  return WORDS.test(all) && (TIME.test(all) || PHONE.test(all))
}

/**
 * A client's last word that asks nothing and closes the talk («Большое спасибо)», «Договорились) Благодарю»): it is no
 * message left unanswered.
 */
export function isFarewell(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/ё/g, 'е')
  if (t.length === 0 || t.length > 70 || t.includes('?')) return false
  return /^(большое |огромное |еще раз |ещё раз )?(спасибо|благодарю|благодарствую)|^договорились|^хорошо[.!)\s]*$|^отлично[.!)\s]*$|^ок[.!)\s]*$|^понял[а]?[.!)\s]*$|^ясно[.!)\s]*$|^до связи|^до встречи|^буду ждать|^жду[.!)\s]*(звонка)?[.!)\s]*$|^принято/u.test(
    t,
  )
}

/** The Moscow time «ГГГГ-ММ-ДД ЧЧ:ММ» as a moment, or null for anything else. */
export function parseMoscow(at: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec((at ?? '').trim())
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 3, Number(mi))
  return Number.isNaN(t) ? null : new Date(t)
}

/** A meeting stands for this conversation: booked, not yet given an outcome. */
export async function hasBookedMeeting(db: Db, conversationId: string): Promise<boolean> {
  const [m] = await db
    .select({ id: meeting.id })
    .from(meeting)
    .where(
      and(
        eq(meeting.conversationId, conversationId),
        eq(meeting.status, 'booked'),
        isNull(meeting.outcome),
      ),
    )
    .limit(1)
  return m !== undefined
}

export type MeetingDeps = {
  db: Db
  gateway: Pick<Gateway, 'call'>
  notifier: Pick<Notifier, 'sendText' | 'editText' | 'pinPost' | 'forumOn'>
  now?: () => Date
}

const mskNow = (now: Date) => {
  const m = new Date(now.getTime() + 3 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  const day = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'][
    m.getUTCDay()
  ]
  return `${m.getUTCFullYear()}-${p(m.getUTCMonth() + 1)}-${p(m.getUTCDate())} (${day}) ${p(m.getUTCHours())}:${p(m.getUTCMinutes())}`
}
const mskStamp = (iso: string) => {
  const m = new Date(new Date(iso).getTime() + 3 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${m.getUTCFullYear()}-${p(m.getUTCMonth() + 1)}-${p(m.getUTCDate())} ${p(m.getUTCHours())}:${p(m.getUTCMinutes())}`
}

/** The last words of the chat for the model, who said them and when (Moscow). */
async function recent(db: Db, conversationId: string) {
  const rows = await db
    .select()
    .from(chatMessage)
    .where(and(eq(chatMessage.conversationId, conversationId), ne(chatMessage.side, 'system')))
    .orderBy(desc(chatMessage.sentAt), desc(chatMessage.platformMessageId))
    .limit(14)
  return rows.reverse()
}

async function activeMeeting(db: Db, conversationId: string) {
  const [m] = await db
    .select()
    .from(meeting)
    .where(
      and(
        eq(meeting.conversationId, conversationId),
        isNull(meeting.outcome),
        ne(meeting.status, 'cancelled'),
      ),
    )
    .orderBy(asc(meeting.createdAt))
    .limit(1)
  return m ?? null
}

/** Reads the new messages of a conversation; never throws (the reading of the chat comes first). */
export async function readMeeting(
  d: MeetingDeps,
  conv: ConversationRow,
  added: StoredMessage[],
): Promise<void> {
  try {
    const fresh = added.filter((m) => m.side !== 'system' && m.text.trim() !== '')
    if (fresh.length === 0 || conv.closedAt || !(await getSetting(d.db, 'pipeline.conversations')))
      return
    const rows = await recent(d.db, conv.id)
    if (!looksLikeMeeting(rows.map((r) => r.text))) return
    const last = rows.at(-1)
    if (!last) return
    // Each last message is read once, so a restart or a second reader does not call the model twice.
    const key = conv.orderId ?? `conv:${conv.id}`
    if (!(await markShown(d.db, key, `meetread:${last.platformMessageId}`))) return
    const now = d.now?.() ?? new Date()
    const known = await activeMeeting(d.db, conv.id)
    const input = [
      '## Сейчас',
      mskNow(now),
      '',
      '## Уже записано',
      known?.startsAt && known.status === 'booked'
        ? `${mskStamp(new Date(known.startsAt).toISOString())} по Москве`
        : 'ничего',
      '',
      '## Переписка',
      ...rows.map(
        (r) =>
          `[${mskStamp(r.sentAt)}] ${r.side === 'client' ? 'Клиент' : 'Мы'}: ${r.text.replace(/\s+/g, ' ').trim()}`,
      ),
    ].join('\n')
    const res = await d.gateway.call('meeting', input, MeetingRead, {
      correlationId: conv.id,
      limitWaitMs: 0,
      redact: { names: await clientNames(d.db, conv) },
    })
    if (!res.ok) {
      // Not read (a limit, a failure): the mark goes, the next message reads it again.
      await d.db.execute(
        sql`delete from core.topic_shown where key = ${key} and ref = ${`meetread:${last.platformMessageId}`}`,
      )
      return
    }
    await applyRead(d, conv, res.output, now, known)
  } catch (e) {
    console.error('meeting not read', e instanceof Error ? e.message.slice(0, 200) : e)
  }
}

type Known = Awaited<ReturnType<typeof activeMeeting>>

async function journal(
  db: Db,
  conv: ConversationRow,
  type: 'meeting.read',
  payload: Record<string, unknown>,
) {
  await appendEvent(db, {
    type,
    v: 1,
    entity: { kind: 'conversation', id: conv.id },
    account_id: conv.accountId,
    actor: 'sara',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: conv.id,
    reason: null,
    // The status and the time only: the words and the contacts of the chat never go to the journal (ADR-016).
    payload,
  })
}

/** What the read means for the meeting and the card. */
export async function applyRead(
  d: MeetingDeps,
  conv: ConversationRow,
  read: MeetingRead,
  now: Date,
  known: Known,
): Promise<void> {
  const at = parseMoscow(read.at)
  const firm =
    at !== null &&
    at.getTime() > now.getTime() - 3600_000 &&
    at.getTime() < now.getTime() + 90 * 24 * 3600_000
  const quote = read.quote?.trim() || null
  const how = read.how && read.how !== 'unknown' ? read.how : null
  const caller = read.caller && read.caller !== 'unknown' ? read.caller : null

  if ((read.status === 'booked' || read.status === 'rescheduled') && firm && at) {
    const same =
      known?.status === 'booked' &&
      known.startsAt &&
      Math.abs(new Date(known.startsAt).getTime() - at.getTime()) < 60_000
    const movedFrom =
      known?.status === 'booked' && known.startsAt && !same
        ? new Date(known.startsAt).toISOString()
        : null
    const id = known?.id ?? newEventId()
    if (known) {
      await d.db
        .update(meeting)
        .set({
          status: 'booked',
          startsAt: at.toISOString(),
          how: how ?? known.how,
          caller: caller ?? known.caller,
          quote: quote ?? known.quote,
          updatedAt: now.toISOString(),
        })
        .where(eq(meeting.id, known.id))
    } else {
      await d.db.insert(meeting).values({
        id,
        conversationId: conv.id,
        title: 'Созвон',
        startsAt: at.toISOString(),
        channel: how,
        status: 'booked',
        source: 'chat',
        how,
        caller,
        quote,
        createdBy: 'sara',
      })
    }
    const deal = await dealOf(d.db, conv)
    if (deal)
      await advanceTo(d.db, {
        dealId: deal.id,
        to: 'call_booked',
        actor: 'sara',
        reason: 'договорились о созвоне в переписке',
        correlationId: conv.id,
      }).catch((e) => console.error('deal not moved on the meeting', e))
    await journal(d.db, conv, 'meeting.read', {
      status: 'booked',
      at: at.toISOString(),
      moved: movedFrom !== null,
    })
    await card(
      d,
      conv,
      id,
      { status: 'booked', at: at.toISOString(), how, caller, quote, movedFrom },
      now,
      true,
    )
    return
  }
  if (read.status === 'cancelled' && known) {
    await d.db
      .update(meeting)
      .set({ status: 'cancelled', outcome: 'cancelled', updatedAt: now.toISOString() })
      .where(eq(meeting.id, known.id))
    await journal(d.db, conv, 'meeting.read', { status: 'cancelled' })
    await card(
      d,
      conv,
      known.id,
      {
        status: 'cancelled',
        at: known.startsAt ? new Date(known.startsAt).toISOString() : null,
        how: known.how,
        caller: known.caller,
        quote,
      },
      now,
      false,
    )
    return
  }
  // «Похоже, договорились»: a note on a card, no slot (no time), no stage. A firm meeting already standing is left alone.
  if (
    (read.status === 'maybe' ||
      ((read.status === 'booked' || read.status === 'rescheduled') && !firm)) &&
    !(known?.status === 'booked')
  ) {
    const id = known?.id ?? newEventId()
    if (known) {
      await d.db
        .update(meeting)
        .set({ quote: quote ?? known.quote, updatedAt: now.toISOString() })
        .where(eq(meeting.id, known.id))
    } else {
      await d.db.insert(meeting).values({
        id,
        conversationId: conv.id,
        title: 'Созвон',
        startsAt: null,
        status: 'maybe',
        source: 'chat',
        how,
        caller,
        quote,
        createdBy: 'sara',
      })
    }
    await journal(d.db, conv, 'meeting.read', { status: 'maybe' })
    await card(d, conv, id, { status: 'maybe', at: null, how, caller, quote }, now, false)
  }
}

/** Puts the card of the meeting in the topic, or edits the one that is there; pinned when it is a booked call. */
async function card(
  d: MeetingDeps,
  conv: ConversationRow,
  id: string,
  v: MeetingCardView,
  now: Date,
  pin: boolean,
): Promise<void> {
  if (!(await d.notifier.forumOn?.())) return
  const html = meetingCard(v, now)
  const [row] = await d.db.select({ ref: meeting.cardRef }).from(meeting).where(eq(meeting.id, id))
  if (row?.ref != null) {
    try {
      if (d.notifier.editText) {
        await d.notifier.editText(row.ref, html, undefined, { html: true })
        return
      }
    } catch (e) {
      console.error(
        'meeting card not edited, a new one is sent',
        e instanceof Error ? e.message.slice(0, 160) : e,
      )
    }
  }
  const sent = await d.notifier.sendText(html, {
    html: true,
    quiet: true,
    place: { conversation: conv.id },
  })
  await d.db.update(meeting).set({ cardRef: sent.messageId }).where(eq(meeting.id, id))
  if (pin)
    await d.notifier
      .pinPost?.(sent.messageId)
      .catch((e) => console.error('meeting card not pinned', e))
}
