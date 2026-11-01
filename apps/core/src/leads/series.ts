import { DBOS } from '@dbos-inc/dbos-sdk'
import { type ChatMessage, type EventType, normalizeText } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import { deliverMessage, queueMessage } from '../conversation/outbox'
import type { Db } from '../db/client'
import { conversation } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { ProfiClient } from '../profi/client'
import { addStatusLine, seriesLine } from './bidStatus'
import { fillCallOffer, isCallOffer, type SlotSource } from './callSlots'

/**
 * The series after a bid (Boris, 29.10.2026): «одного сообщения при отклике мало». Before Sara he wrote one to three
 * short messages within four minutes of his bid (a case or a link «из недавнего)», a promise, a smile), and every such
 * series got an answer. The Analyst writes the series with the bid, Boris approves both with one press, and this
 * durable process sends it into the order's chat once the bid is confirmed: the first message a second or two after
 * the bid (Boris, 31.10.2026: «все письма сразу, в ту же секунду»), the next ones two or three seconds apart, only to
 * keep their order. Before each one the chat is read again: once the client has answered, or Boris wrote himself, the series
 * stops and the conversation goes on as usual. It goes through the message outbox, so the pause of messages to clients,
 * shadow and the line of drafts mode hold for it as for any message of Sara's, and each message goes once.
 */

export type SeriesDeps = {
  db: Db
  profi: ProfiClient
  /**
   * The waits, from and to in ms: before the first message (after the bid) and before each next one (after the one
   * before). Boris's own: the second message 0.7-3.5 minutes after the bid, about 1.6, the third half a minute after
   * it (growth-points, 29.10.2026); the call offer a minute or two after the message before it (Boris, 30.10.2026). The
   * moment within follows the order, the same on a resume.
   */
  delayMs: { first: SeriesWait; next: SeriesWait; call: SeriesWait }
  /** Where the times of the call offer come from: Boris's working hours, his calendar later (M6). */
  slots: SlotSource
}

export type SeriesWait = readonly [number, number]

/**
 * The waits of the live series (Boris, 31.10.2026: «после отклика отправлять все письма сразу, в ту же секунду»): a
 * second or two after the bid, then two or three seconds between the messages, so that they arrive in their order.
 */
export const SERIES_DELAYS = {
  first: [1_000, 2_000],
  next: [2_000, 3_000],
  call: [2_000, 3_000],
} as const

let deps: SeriesDeps | null = null

const d = (): SeriesDeps => {
  if (!deps) throw new Error('the series is not configured')
  return deps
}

export function setSeriesDeps(x: SeriesDeps): void {
  deps = x
}

export type SeriesJob = {
  leadId: string
  accountId: string
  correlationId: string
  /** The texts as Boris approved them with the bid. */
  followUps: string[]
  /**
   * The bid was found on its order later than the press: the first message waits only as long as the next ones do.
   * Kept for a run recorded before the waits were short.
   */
  late?: boolean
}

/** One series per order, whatever presses or restarts there are. */
export const seriesWorkflowId = (leadId: string) => `bid-series:${leadId}`

/** The key of message `n` of an order's series in the outbox; `again` is its one try after the chat moved. */
export const seriesKey = (leadId: string, n: number, again = false) =>
  `series:${leadId}:${n}${again ? ':2' : ''}`

/**
 * The wait before message `n`, within [from, to]: drawn from the order number and the place, so a process that
 * resumes after a restart waits the moment it recorded and the series of two orders do not tick in step.
 */
export function seriesDelay(leadId: string, n: number, [from, to]: SeriesWait): number {
  let h = 2166136261
  for (const ch of `${leadId}:${n}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  return from + (h % (Math.max(0, to - from) + 1))
}

export type SeriesStop =
  | 'client_replied'
  | 'boris_wrote'
  | 'boris_leads'
  | 'not_now'
  | 'not_sent'
  /** The call offer found no free time to give. */
  | 'no_slots'

/** Which rule stopped the series and the authors of the chat's messages in order, never their text (ADR-016). */
export type StopDetail = { rule: string; authors: string[] }

/** What the chat says before a message: go, with the last message the node must still see, or stop. */
export type SeriesGround =
  | { go: true; chatId: string; expectLast: string | null }
  | { go: false; why: SeriesStop; detail: StopDetail }

/** How near to the bid a second message of our side is still part of it (the price line the site adds to a bid). */
const BID_BURST_MS = 15_000
/** A line of the site about the bid itself: its price or its mark, short. */
const BID_NOTE = /(стоимост|₽|руб|отклик)/i

/**
 * Whether a message of our side that is not the series was written by someone on the site, not by a service of it: the
 * bid is the first message of ours, and what the site puts beside it (a price line a moment later, a note about the
 * response) is not Boris writing (Boris, 31.10.2026: the series of order 95583456 stopped as «boris_wrote» though he
 * wrote nothing). A message of an author nobody knows (the site's own cards) is no one's word either.
 */
export function foreignOurs(
  messages: readonly ChatMessage[],
  sent: readonly string[],
): ChatMessage | undefined {
  const ours = new Set(sent.map(normalizeText))
  const mine = messages.filter((m) => m.author === 'specialist')
  const bidAt = mine[0] ? Date.parse(mine[0].sent_at) : Number.NaN
  return mine.slice(1).find((m) => {
    if (ours.has(normalizeText(m.text))) return false
    if (Math.abs(Date.parse(m.sent_at) - bidAt) <= BID_BURST_MS) return false
    return !(m.text.length <= 160 && BID_NOTE.test(m.text))
  })
}

/**
 * Step: the order's chat read again before message `n` (`sent` are the texts of the series already in it). The chat of
 * a bid is the order's own number unless a conversation of the order names another. A client's word, a message of our
 * side that is neither the bid nor the series (Boris wrote himself) or one of a side nobody knows stops the series, as
 * does a conversation Boris leads or closed. A chat the node cannot read yet goes on with nothing expected: the node
 * types only into a chat that is just as it was seen, so it refuses (and reads the chat for the next try).
 */
export async function groundSeries(job: SeriesJob, sent: readonly string[]): Promise<SeriesGround> {
  const [conv] = await d()
    .db.select()
    .from(conversation)
    .where(and(eq(conversation.accountId, job.accountId), eq(conversation.orderId, job.leadId)))
  if (conv && (conv.owner !== 'sara' || conv.closedAt !== null))
    return {
      go: false,
      why: 'boris_leads',
      detail: {
        rule: conv.closedAt !== null ? 'conversation_closed' : 'conversation_owner',
        authors: [],
      },
    }
  const chatId = conv?.chatId ?? job.leadId
  const messages = await d()
    .profi.readChat(job.accountId, chatId)
    .then((r) => r.messages)
    .catch(() => [])
  const authors = messages.map((m) => m.author)
  if (authors.includes('client'))
    return { go: false, why: 'client_replied', detail: { rule: 'client_message', authors } }
  // The first message of our side is the bid itself; after it only the series, or the site's own lines, may stand.
  if (foreignOurs(messages, sent))
    return { go: false, why: 'boris_wrote', detail: { rule: 'other_specialist_message', authors } }
  return { go: true, chatId, expectLast: messages.at(-1)?.platform_message_id ?? null }
}

/** Step: message `n` enters the outbox once per key; null when it may not go (shadow, a pause, drafts mode). */
async function queueSeries(
  job: SeriesJob,
  n: number,
  text: string,
  g: { chatId: string; expectLast: string | null },
  again: boolean,
): Promise<string | null> {
  return d().db.transaction((tx) =>
    queueMessage(tx, {
      key: seriesKey(job.leadId, n, again),
      accountId: job.accountId,
      chatId: g.chatId,
      text,
      author: 'sara',
      expectLast: g.expectLast,
    }),
  )
}

/** The journal keeps where the series went, never its text (ADR-016). */
async function journal(job: SeriesJob, type: EventType, payload: Record<string, unknown>) {
  await appendEvent(d().db, {
    type,
    v: 1,
    entity: { kind: 'lead', id: job.leadId },
    account_id: job.accountId,
    actor: 'sara',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: job.correlationId,
    reason: typeof payload.why === 'string' ? payload.why : null,
    payload,
  })
}

const DB_STEP = { retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2 }

/** One message: the chat read, the outbox, the delivery; once more after the chat moved under it (CHAT_CHANGED). */
/** Step: the call offer with its times picked now, or null when there are none to give. */
async function callText(template: string, leadId: string): Promise<string | null> {
  const now = new Date()
  const slots = await d().slots.slots(now, { leadId })
  return slots.length > 0 ? fillCallOffer(template, slots, now) : null
}

async function sendOne(
  job: SeriesJob,
  n: number,
  text: string,
  sent: string[],
): Promise<{ why: SeriesStop; detail?: StopDetail } | null> {
  for (const again of [false, true]) {
    const g = await DBOS.runStep(() => groundSeries(job, sent), {
      name: `ground-${n}${again ? '-again' : ''}`,
      ...DB_STEP,
    })
    if (!g.go) return { why: g.why, detail: g.detail }
    const id = await DBOS.runStep(() => queueSeries(job, n, text, g, again), {
      name: `queue-${n}${again ? '-again' : ''}`,
      ...DB_STEP,
    })
    if (!id) return { why: 'not_now', detail: { rule: 'outbox_refused', authors: [] } }
    const r = await DBOS.runStep(() => deliverMessage(d(), id), {
      name: `deliver-${n}${again ? '-again' : ''}`,
      ...DB_STEP,
    })
    if (r === 'confirmed') return null
    if (r !== 'changed') return { why: 'not_sent', detail: { rule: `delivery_${r}`, authors: [] } }
  }
  return { why: 'not_sent', detail: { rule: 'chat_changed_twice', authors: [] } }
}

async function runSeries(job: SeriesJob): Promise<void> {
  const sent: string[] = []
  for (let n = 0; n < job.followUps.length; n++) {
    const waits = d().delayMs
    const approved = job.followUps[n] ?? ''
    const call = isCallOffer(approved)
    await DBOS.sleep(
      seriesDelay(
        job.leadId,
        n,
        n === 0 && !job.late ? waits.first : call ? waits.call : waits.next,
      ),
    )
    // Only the call offer has a step of its own here: a series of before it resumes along the steps it took.
    const text = call
      ? await DBOS.runStep(() => callText(approved, job.leadId), { name: `times-${n}`, ...DB_STEP })
      : approved
    const stop = text === null ? { why: 'no_slots' as const } : await sendOne(job, n, text, sent)
    if (stop) {
      await DBOS.runStep(() => journal(job, 'bid.series_stopped', { n, ...stop }), {
        name: `stopped-${n}`,
        ...DB_STEP,
      })
      if (await DBOS.patch('bid-series-status'))
        await DBOS.runStep(() => status(job, sent.length, stop.why), { name: 'status-stopped' })
      return
    }
    sent.push(text ?? '')
    await DBOS.runStep(() => journal(job, 'bid.series_sent', { n }), {
      name: `sent-${n}`,
      ...DB_STEP,
    })
  }
  if (await DBOS.patch('bid-series-status'))
    await DBOS.runStep(() => status(job, sent.length), { name: 'status-done' })
}

/** Step: the line about the series goes under the status message of the bid (one message for the whole bid). */
async function status(job: SeriesJob, sent: number, why?: SeriesStop): Promise<void> {
  await addStatusLine(job.leadId, seriesLine(sent, why)).catch(() => {})
}

const seriesWorkflow = DBOS.registerWorkflow(runSeries, { name: 'bidSeries' })

/** Starts the series of a confirmed bid; a second start for the same order is the process there is. */
export async function startSeries(job: SeriesJob): Promise<void> {
  if (job.followUps.length === 0) return
  await DBOS.startWorkflow(seriesWorkflow, { workflowID: seriesWorkflowId(job.leadId) })(job)
}
