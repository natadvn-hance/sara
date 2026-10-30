import { DBOS } from '@dbos-inc/dbos-sdk'
import { type EventType, normalizeText } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import { deliverMessage, queueMessage } from '../conversation/outbox'
import type { Db } from '../db/client'
import { conversation } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { ProfiClient } from '../profi/client'
import { fillCallOffer, isCallOffer, type SlotSource } from './callSlots'

/**
 * The series after a bid (Boris, 29.10.2026): «одного сообщения при отклике мало». Before Sara he wrote one to three
 * short messages within four minutes of his bid (a case or a link «из недавнего)», a promise, a smile), and every such
 * series got an answer. The Analyst writes the series with the bid, Boris approves both with one press, and this
 * durable process sends it into the order's chat once the bid is confirmed: the first message a minute or two after
 * the bid, the next ones half a minute apart. Before each one the chat is read again: once the client has answered, or Boris wrote himself, the series
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
 * The waits of the live series: a minute or two after the bid, then 20-40 seconds between the messages, and the call
 * offer a minute or two after them.
 */
export const SERIES_DELAYS = {
  first: [60_000, 120_000],
  next: [20_000, 40_000],
  call: [60_000, 120_000],
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
   * The bid was found on its order later, minutes after the press: the moment for a first wait of a minute or two has
   * passed, so the first message waits only as long as the next ones do.
   */
  late?: boolean
}

/**
 * A bid found on its order later than this after the press gets no series (Boris's own went within four minutes of
 * his bid): «Из недавнего)» a quarter of an hour on reads as a reminder, not as the same breath as the bid.
 */
export const SERIES_LATE_MS = 15 * 60_000

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

/** What the chat says before a message: go, with the last message the node must still see, or stop. */
export type SeriesGround =
  | { go: true; chatId: string; expectLast: string | null }
  | { go: false; why: SeriesStop }

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
    return { go: false, why: 'boris_leads' }
  const chatId = conv?.chatId ?? job.leadId
  const messages = await d()
    .profi.readChat(job.accountId, chatId)
    .then((r) => r.messages)
    .catch(() => [])
  if (messages.some((m) => m.author === 'client')) return { go: false, why: 'client_replied' }
  const ours = new Set(sent.map(normalizeText))
  const mine = messages.filter((m) => m.author === 'specialist')
  // The first message of our side is the bid itself; after it only the series may stand.
  if (
    messages.some((m) => m.author === 'unknown') ||
    mine.slice(1).some((m) => !ours.has(normalizeText(m.text)))
  )
    return { go: false, why: 'boris_wrote' }
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
async function callText(template: string): Promise<string | null> {
  const now = new Date()
  const slots = await d().slots.slots(now)
  return slots.length > 0 ? fillCallOffer(template, slots, now) : null
}

async function sendOne(
  job: SeriesJob,
  n: number,
  text: string,
  sent: string[],
): Promise<SeriesStop | null> {
  for (const again of [false, true]) {
    const g = await DBOS.runStep(() => groundSeries(job, sent), {
      name: `ground-${n}${again ? '-again' : ''}`,
      ...DB_STEP,
    })
    if (!g.go) return g.why
    const id = await DBOS.runStep(() => queueSeries(job, n, text, g, again), {
      name: `queue-${n}${again ? '-again' : ''}`,
      ...DB_STEP,
    })
    if (!id) return 'not_now'
    const r = await DBOS.runStep(() => deliverMessage(d(), id), {
      name: `deliver-${n}${again ? '-again' : ''}`,
      ...DB_STEP,
    })
    if (r === 'confirmed') return null
    if (r !== 'changed') return 'not_sent'
  }
  return 'not_sent'
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
      ? await DBOS.runStep(() => callText(approved), { name: `times-${n}`, ...DB_STEP })
      : approved
    const stop = text === null ? 'no_slots' : await sendOne(job, n, text, sent)
    if (stop) {
      await DBOS.runStep(() => journal(job, 'bid.series_stopped', { n, why: stop }), {
        name: `stopped-${n}`,
        ...DB_STEP,
      })
      return
    }
    sent.push(text ?? '')
    await DBOS.runStep(() => journal(job, 'bid.series_sent', { n }), {
      name: `sent-${n}`,
      ...DB_STEP,
    })
  }
}

const seriesWorkflow = DBOS.registerWorkflow(runSeries, { name: 'bidSeries' })

/** Starts the series of a confirmed bid; a second start for the same order is the process there is. */
export async function startSeries(job: SeriesJob): Promise<void> {
  if (job.followUps.length === 0) return
  await DBOS.startWorkflow(seriesWorkflow, { workflowID: seriesWorkflowId(job.leadId) })(job)
}
