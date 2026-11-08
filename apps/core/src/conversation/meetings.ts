import { newEventId } from '@sara/shared'
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { chatMessage, jobRun, lead, meeting } from '../db/schema'
import { advanceTo } from '../domain/deal'
import type { Gateway } from '../gateway/gateway'
import { appendEvent } from '../journal/journal'
import { firstName } from '../leads/clientName'
import { markShown, topicIntro } from '../notify/forum'
import { type MeetingCardView, meetingCard } from '../notify/meetingCard'
import type { Notifier } from '../notify/notifier'
import { getSetting } from '../settings/store'
import { contactsLine, contactsOf } from './contacts'
import { clientNames } from './dossier'
import { dealOf } from './stage'
import { getConversation as getConversationRow } from './store'
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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export type MeetingDeps = {
  db: Db
  gateway: Pick<Gateway, 'call'>
  notifier: Pick<Notifier, 'sendText' | 'editText' | 'pinPost' | 'forumOn' | 'topicPosts'>
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

/** What the model is given: the time now, the meeting already on record and the last words, each with its Moscow time. */
export function meetingInput(i: {
  now: Date
  known: { status: string; at: string | null } | null
  messages: { at: string; client: boolean; text: string }[]
}): string {
  const standing =
    i.known?.status === 'booked' && i.known.at
      ? `${mskStamp(i.known.at)} по Москве`
      : i.known?.status === 'maybe'
        ? 'похоже, договорились, но твёрдого времени нет'
        : 'ничего'
  return [
    '## Сейчас',
    mskNow(i.now),
    '',
    '## Уже записано',
    standing,
    '',
    '## Переписка',
    ...i.messages.map(
      (m) =>
        `[${mskStamp(m.at)}] ${m.client ? 'Клиент' : 'Мы'}: ${m.text.replace(/\s+/g, ' ').trim()}`,
    ),
  ].join('\n')
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
    const input = meetingInput({
      now,
      known: known
        ? {
            status: known.status,
            at: known.startsAt ? new Date(known.startsAt).toISOString() : null,
          }
        : null,
      messages: rows.map((r) => ({ at: r.sentAt, client: r.side === 'client', text: r.text })),
    })
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
  const html = meetingCard(
    { ...v, contacts: v.contacts ?? (await contactsLineOf(d.db, conv)) },
    now,
  )
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
  // No right to pin is no error: the card is there all the same.
  if (pin) await Promise.resolve(d.notifier.pinPost?.(sent.messageId)).catch(() => {})
}

/** What came of a call: told by Lora (her note of Boris's story) or by Boris in the topic. */
export type MeetingResult = {
  held: boolean
  /** When the call was (ISO); none: the time of the meeting on record stands. */
  at?: string | null
  result: string | null
  nextStep: string | null
  /** The day of the next step, `YYYY-MM-DD` (Moscow). */
  nextStepOn: string | null
  source: 'lora' | 'boris'
}

/** The meeting an outcome belongs to: the latest one with no outcome yet. */
async function openMeeting(db: Db, conversationId: string) {
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
    .orderBy(desc(meeting.createdAt))
    .limit(1)
  return m ?? null
}

/** Meetings of one call closer than this are one meeting, whoever wrote them down. */
const SAME_CALL_MS = 24 * 3600_000

/**
 * The meeting an outcome belongs to (Boris, 06.11: the outcome of Lora found no meeting Boris had entered by hand and made
 * a second one): of the conversation's meetings, any source and any outcome, the one nearest in time to the call, within
 * a day; failing that, the latest with no outcome yet.
 */
export async function standingMeeting(db: Db, conversationId: string, around: Date) {
  const all = await db
    .select()
    .from(meeting)
    .where(
      and(
        eq(meeting.conversationId, conversationId),
        sql`${meeting.status} not in ('cancelled', 'duplicate')`,
      ),
    )
    .orderBy(desc(meeting.createdAt))
  const near = all
    .filter((m) => m.startsAt)
    .map((m) => ({ m, d: Math.abs(new Date(m.startsAt ?? 0).getTime() - around.getTime()) }))
    .filter((x) => x.d <= SAME_CALL_MS)
    .sort((a, b) => a.d - b.d)[0]
  return near?.m ?? all.find((m) => m.outcome === null) ?? null
}

/**
 * Writes down the outcome of a call (Boris, 03.11: «после проведения встречи хочу, чтобы внутри чата с клиентом была
 * информация о том что встреча была проведена и следующие шаги»): the meeting gets its result and next step, a held
 * one moves the deal to the done call, and the card becomes «Встреча прошла» in place. Time alone proves nothing: only
 * a word of Lora's or Boris's gets here.
 */
export async function recordMeetingResult(
  d: MeetingDeps,
  conv: ConversationRow,
  r: MeetingResult,
  now: Date,
): Promise<string> {
  const at = r.at ? new Date(r.at) : null
  const known = await standingMeeting(d.db, conv.id, at && !Number.isNaN(at.getTime()) ? at : now)
  const id = known?.id ?? newEventId()
  const outcome = r.held ? 'held' : 'missed'
  const startsAt = known?.startsAt ?? (at && !Number.isNaN(at.getTime()) ? at.toISOString() : null)
  const fields = {
    outcome,
    status: 'booked',
    // What an earlier word of the call said stays when this one adds to it.
    result: r.result ?? known?.result ?? null,
    nextStep: r.nextStep ?? known?.nextStep ?? null,
    nextStepOn: r.nextStepOn ?? known?.nextStepOn ?? null,
    resultSource: r.source,
    resultAt: now.toISOString(),
    startsAt,
    updatedAt: now.toISOString(),
  }
  if (known) await d.db.update(meeting).set(fields).where(eq(meeting.id, known.id))
  else
    await d.db.insert(meeting).values({
      id,
      conversationId: conv.id,
      title: 'Созвон',
      source: r.source,
      createdBy: r.source === 'lora' ? 'lora' : 'boris',
      ...fields,
    })
  if (r.held) {
    const deal = await dealOf(d.db, conv)
    if (deal)
      await advanceTo(d.db, {
        dealId: deal.id,
        to: 'call_done',
        actor: r.source === 'boris' ? 'boris' : 'sara',
        reason: 'встреча прошла',
        correlationId: conv.id,
      }).catch((e) => console.error('deal not moved on the result', e))
  }
  // The journal keeps the fact and the day, never the words of the result (ADR-016).
  await appendEvent(d.db, {
    type: 'meeting.result',
    v: 1,
    entity: { kind: 'conversation', id: conv.id },
    account_id: conv.accountId,
    actor: r.source === 'boris' ? 'boris' : 'sara',
    occurred_at: now.toISOString(),
    causation_id: null,
    correlation_id: conv.id,
    reason: null,
    payload: { held: r.held, source: r.source, next_step_on: r.nextStepOn },
  })
  await card(
    d,
    conv,
    id,
    {
      status: r.held ? 'held' : 'missed',
      at: startsAt ? new Date(startsAt).toISOString() : null,
      how: known?.how ?? null,
      caller: known?.caller ?? null,
      quote: null,
      result: r.result ?? known?.result ?? null,
      nextStep: r.nextStep ?? known?.nextStep ?? null,
      nextStepOn: r.nextStepOn ?? known?.nextStepOn ?? null,
    },
    now,
    false,
  )
  return id
}

export const ResultRead = z.object({
  kind: z.enum(['result', 'not_held', 'for_client', 'other']),
  result: z.string().nullable().optional(),
  next_step: z.string().nullable().optional(),
  next_step_on: z.string().nullable().optional(),
})
export type ResultRead = z.infer<typeof ResultRead>

const REPORT =
  /созвонил|созвонились|поговорил|поговорили|пообщал|обсудил|обсудили|позвонил|дозвонил|переговорил|(разговор|звонок|созвон|встреча|встречу)\s+(был|была|прошл|состоял)|встреч[аиуы]?\s+(прошл|состоял|не состоял)|не\s+(вышел|вышла|ответил|ответила|взял|взяла)/iu

/** The cheap gate for Boris's own words: does it sound like a report of a call. */
export const looksLikeReport = (text: string): boolean => REPORT.test(text)

/** The day `YYYY-MM-DD` of a model's answer, or null. */
const asDay = (s: string | null | undefined) =>
  /^\d{4}-\d{2}-\d{2}$/.test((s ?? '').trim()) ? (s as string).trim() : null

/**
 * Boris's words in a client's topic, typed or spoken: when they tell how a call went, the outcome and the next step go
 * on the card (no question to him; a line says so), and the words are not offered to the client. Words for the client,
 * or anything else, are left to the usual flow (null). Never throws.
 */
export async function readBorisResult(
  d: MeetingDeps,
  conv: ConversationRow,
  text: string,
  now: Date = d.now?.() ?? new Date(),
): Promise<string | null> {
  try {
    if (!looksLikeReport(text) || conv.closedAt) return null
    const known = await openMeeting(d.db, conv.id)
    const input = [
      '## Сейчас',
      mskNow(now),
      '',
      '## Запись о созвоне',
      known?.startsAt ? `${mskStamp(new Date(known.startsAt).toISOString())} по Москве` : 'нет',
      '',
      '## Сообщение Бориса',
      text.replace(/\s+/g, ' ').trim(),
    ].join('\n')
    const res = await d.gateway.call('meeting-result', input, ResultRead, {
      correlationId: conv.id,
      limitWaitMs: 0,
      redact: { names: await clientNames(d.db, conv) },
    })
    if (!res.ok) return null
    const o = res.output
    if (o.kind !== 'result' && o.kind !== 'not_held') return null
    await recordMeetingResult(
      d,
      conv,
      {
        held: o.kind === 'result',
        result: o.result?.trim() || null,
        nextStep: o.next_step?.trim() || null,
        nextStepOn: asDay(o.next_step_on),
        source: 'boris',
      },
      now,
    )
    return o.kind === 'result'
      ? 'Записала итог встречи на карточке в теме. Клиенту ничего не ушло.'
      : 'Записала, что встреча не состоялась. Клиенту ничего не ушло.'
  } catch (e) {
    console.error(
      'result of the meeting not read',
      e instanceof Error ? e.message.slice(0, 200) : e,
    )
    return null
  }
}

const mskDay = (t: Date) => new Date(t.getTime() + 3 * 3600_000).toISOString().slice(0, 10)
const mskHour = (t: Date) => new Date(t.getTime() + 3 * 3600_000).getUTCHours()
/** Meetings whose time passed with no outcome are told so, this long after their start. */
const EXPIRE_AFTER_MS = 3 * 3600_000

/**
 * The two quiet jobs after a call: a booked meeting whose time has passed with no word of its outcome gets its card
 * edited to «время прошло, итога нет» (no message, no question; it does not count as held), and on the day of a next
 * step one short reminder goes into the topic, in working hours (9 to 19 Moscow), once.
 */
export async function meetingsTick(
  d: MeetingDeps,
  now: Date = d.now?.() ?? new Date(),
): Promise<number> {
  if (!(await d.notifier.forumOn?.())) return 0
  let done = 0
  const passed = await d.db
    .select()
    .from(meeting)
    .where(
      and(
        eq(meeting.status, 'booked'),
        isNull(meeting.outcome),
        isNull(meeting.expiredAt),
        sql`${meeting.startsAt} < ${new Date(now.getTime() - EXPIRE_AFTER_MS).toISOString()}`,
        sql`${meeting.cardRef} is not null`,
      ),
    )
  for (const m of passed) {
    const conv = m.conversationId ? await getConversationRow(d.db, m.conversationId) : null
    await d.db.update(meeting).set({ expiredAt: now.toISOString() }).where(eq(meeting.id, m.id))
    if (!conv) continue
    await card(
      d,
      conv,
      m.id,
      {
        status: 'expired',
        at: m.startsAt ? new Date(m.startsAt).toISOString() : null,
        how: m.how,
        caller: m.caller,
        quote: null,
      },
      now,
      false,
    ).catch((e) => console.error('expired meeting card not edited', e))
    done++
  }
  const hour = mskHour(now)
  if (hour >= 9 && hour < 19) {
    const due = await d.db
      .select()
      .from(meeting)
      .where(
        and(
          eq(meeting.outcome, 'held'),
          isNull(meeting.nextRemindedAt),
          sql`${meeting.nextStep} is not null`,
          sql`${meeting.nextStepOn} <= ${mskDay(now)}`,
        ),
      )
    for (const m of due) {
      if (!m.conversationId || !m.nextStep) continue
      await d.db
        .update(meeting)
        .set({ nextRemindedAt: now.toISOString() })
        .where(eq(meeting.id, m.id))
      await d.notifier
        .sendText(`⏰ <b>Сегодня шаг по клиенту:</b> ${esc(m.nextStep)}`, {
          html: true,
          place: { conversation: m.conversationId },
        })
        .catch((e) => console.error('next step reminder not sent', e))
      done++
    }
  }
  return done
}

export function startMeetingTick(d: MeetingDeps, tickMs = 60_000): { stop(): void } {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void meetingsTick(d)
      .catch((e) => console.error('meeting tick failed', e instanceof Error ? e.message : e))
      .finally(() => {
        running = false
      })
  }, tickMs)
  return { stop: () => clearInterval(timer) }
}

/**
 * Once: a call written down twice (Boris's by hand, then Lora's outcome as a second row) is one meeting. Of the meetings of
 * a conversation whose times are within a day, the oldest stays and takes the outcome, the card and the next step of the
 * others; the others are marked `duplicate` (not deleted), and the readers of meetings leave them out. A mark in job_run
 * keeps it from repeating. Returns how many rows were marked.
 */
export async function dedupeMeetings(db: Db): Promise<number> {
  const taken = await db
    .insert(jobRun)
    .values({ name: 'meetings_dedup', day: '2000-01-01' })
    .onConflictDoNothing()
    .returning({ day: jobRun.day })
  if (taken.length === 0) return 0
  const rows = await db
    .select()
    .from(meeting)
    .where(
      and(
        sql`${meeting.conversationId} is not null`,
        sql`${meeting.startsAt} is not null`,
        sql`${meeting.status} not in ('cancelled', 'duplicate', 'maybe')`,
      ),
    )
    .orderBy(asc(meeting.conversationId), asc(meeting.createdAt))
  let marked = 0
  const byConv = new Map<string, typeof rows>()
  for (const r of rows)
    byConv.set(r.conversationId as string, [...(byConv.get(r.conversationId as string) ?? []), r])
  for (const list of byConv.values()) {
    const kept: (typeof rows)[number][] = []
    for (const m of list) {
      const t = new Date(m.startsAt ?? 0).getTime()
      const keeper = kept.find(
        (k) => Math.abs(new Date(k.startsAt ?? 0).getTime() - t) <= SAME_CALL_MS,
      )
      if (!keeper) {
        kept.push(m)
        continue
      }
      await db
        .update(meeting)
        .set({
          outcome: keeper.outcome ?? m.outcome,
          result: keeper.result ?? m.result,
          nextStep: keeper.nextStep ?? m.nextStep,
          nextStepOn: keeper.nextStepOn ?? m.nextStepOn,
          resultSource: keeper.resultSource ?? m.resultSource,
          resultAt: keeper.resultAt ?? m.resultAt,
          cardRef: keeper.cardRef ?? m.cardRef,
          nextRemindedAt: keeper.nextRemindedAt ?? m.nextRemindedAt,
          amountRub: keeper.amountRub ?? m.amountRub,
          note: keeper.note ?? m.note,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(meeting.id, keeper.id))
      await db
        .update(meeting)
        .set({ status: 'duplicate', updatedAt: new Date().toISOString() })
        .where(eq(meeting.id, m.id))
      Object.assign(keeper, {
        outcome: keeper.outcome ?? m.outcome,
        result: keeper.result ?? m.result,
        nextStep: keeper.nextStep ?? m.nextStep,
        nextStepOn: keeper.nextStepOn ?? m.nextStepOn,
        cardRef: keeper.cardRef ?? m.cardRef,
      })
      marked++
    }
  }
  return marked
}

/** The contacts line of a conversation, without the name the order already carries. */
async function contactsLineOf(db: Db, conv: ConversationRow): Promise<string | null> {
  const [l] = conv.orderId
    ? await db.select({ name: lead.clientName }).from(lead).where(eq(lead.id, conv.orderId))
    : []
  const own = l?.name ? firstName(l.name) : null
  return contactsLine(await contactsOf(db, { conversationId: conv.id }, own ? [own] : []))
}

const hash = (s: string) => {
  let h = 5381
  for (const ch of s) h = ((h << 5) + h + ch.charCodeAt(0)) | 0
  return (h >>> 0).toString(36)
}

/** The card of a meeting drawn again from its row (the contacts changed). */
async function redraw(
  d: MeetingDeps,
  conv: ConversationRow,
  m: typeof meeting.$inferSelect,
  now: Date,
) {
  const status: MeetingCardView['status'] =
    m.outcome === 'held'
      ? 'held'
      : m.outcome === 'missed'
        ? 'missed'
        : m.expiredAt
          ? 'expired'
          : m.status === 'maybe'
            ? 'maybe'
            : 'booked'
  await card(
    d,
    conv,
    m.id,
    {
      status,
      at: m.startsAt ? new Date(m.startsAt).toISOString() : null,
      how: m.how,
      caller: m.caller,
      quote: m.quote,
      result: m.result,
      nextStep: m.nextStep,
      nextStepOn: m.nextStepOn,
    },
    now,
    false,
  )
}

/**
 * New contacts in the talk (a name, a phone, a Telegram, a mail): the first post of the topic and the card of the
 * meeting are drawn again with them, once for each set. Never throws.
 */
export async function refreshContacts(d: MeetingDeps, conv: ConversationRow): Promise<void> {
  try {
    if (conv.closedAt || !(await d.notifier.forumOn?.())) return
    const line = await contactsLineOf(d.db, conv)
    if (!line) return
    const key = conv.orderId ?? `conv:${conv.id}`
    if (!(await markShown(d.db, key, `contacts:${hash(line)}`))) return
    const place = { conversation: conv.id }
    const first = (await d.notifier.topicPosts?.(place))?.[0]
    if (first !== undefined && d.notifier.editText)
      await d.notifier
        .editText(first, (await topicIntro(d.db, key)).intro, undefined, { html: true })
        .catch(() => {})
    const now = d.now?.() ?? new Date()
    const rows = await d.db
      .select()
      .from(meeting)
      .where(
        and(
          eq(meeting.conversationId, conv.id),
          sql`${meeting.status} not in ('cancelled', 'duplicate')`,
          sql`${meeting.cardRef} is not null`,
        ),
      )
    for (const m of rows) await redraw(d, conv, m, now).catch(() => {})
  } catch (e) {
    console.error('contacts not refreshed', e instanceof Error ? e.message.slice(0, 200) : e)
  }
}

/**
 * Once at start: the meetings already on a card get the contacts of their talk (part 3 came after them, 07.11.2026),
 * so the first post and the card show them without waiting for the client's next word. A set drawn before is skipped
 * by refreshContacts itself, so a restart draws nothing again. Never throws.
 */
export async function refreshMeetingContacts(d: MeetingDeps): Promise<number> {
  try {
    const rows = await d.db
      .selectDistinct({ id: meeting.conversationId })
      .from(meeting)
      .where(
        and(
          sql`${meeting.status} not in ('cancelled', 'duplicate')`,
          sql`${meeting.cardRef} is not null`,
          sql`${meeting.conversationId} is not null`,
        ),
      )
    let n = 0
    for (const r of rows) {
      const conv = r.id ? await getConversationRow(d.db, r.id) : null
      if (!conv) continue
      await refreshContacts(d, conv)
      n++
    }
    return n
  } catch (e) {
    console.error('meeting contacts pass failed', e instanceof Error ? e.message.slice(0, 200) : e)
    return 0
  }
}

/** The news of a chat for the meeting side: the contacts first, then the call booked in it. */
export async function meetingNews(
  d: MeetingDeps,
  conv: ConversationRow,
  added: StoredMessage[],
): Promise<void> {
  await refreshContacts(d, conv)
  await readMeeting(d, conv, added)
}
