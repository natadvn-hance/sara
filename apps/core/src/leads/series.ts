import { DBOS } from '@dbos-inc/dbos-sdk'
import { type ChatMessage, type EventType, normalizeText } from '@sara/shared'
import { and, eq, gt, sql } from 'drizzle-orm'
import { deliverMessage, queueMessage } from '../conversation/outbox'
import type { Db } from '../db/client'
import { conversation, event, outbox } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { markShown } from '../notify/forum'
import type { Notifier } from '../notify/notifier'
import { seriesPost } from '../notify/topicPosts'
import type { ProfiClient } from '../profi/client'
import { addStatusLine, seriesLine } from './bidStatus'
import { fillCallOffer, isApprovedText, isCallOffer, type SlotSource } from './callSlots'

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
  /** Where a sent message is shown in the client's topic; left out, it is not shown. */
  notifier?: Pick<Notifier, 'sendText' | 'forumOn'>
  /**
   * The waits between the tries of a message the node could not answer for (a restart of the node, a lost answer):
   * the chat is read after each, and the message goes again only when it is not in the chat (31.10.2026).
   */
  unsureWaitsMs: number[]
}

export type SeriesWait = readonly [number, number]

/** The live waits after an unsure delivery: a node that restarts is back within a minute or two. */
export const SERIES_UNSURE_WAITS_MS = [15_000, 30_000, 60_000, 120_000]

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
  /** Starts at this place of the series: the earlier messages went already (a series taken up again, 01.11.2026). */
  from?: number
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
  approved: readonly string[] = [],
): ChatMessage | undefined {
  const ours = new Set(sent.map(normalizeText))
  const mine = messages.filter((m) => m.author === 'specialist')
  const bidAt = mine[0] ? Date.parse(mine[0].sent_at) : Number.NaN
  return mine.slice(1).find((m) => {
    if (ours.has(normalizeText(m.text))) return false
    // A message of the series as Boris approved it (the call offer with its times put in) is ours too.
    if (approved.some((a) => isApprovedText(a, m.text))) return false
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
  // Only a word after our bid is an answer to it: a client may write first (an invitation of a specialist), and the
  // series still follows the bid (Boris, 31.10.2026, test order 99793452149).
  const bidAt = messages.findIndex((m) => m.author === 'specialist')
  if (bidAt >= 0 && messages.slice(bidAt + 1).some((m) => m.author === 'client'))
    return {
      go: false,
      why: 'client_replied',
      detail: { rule: 'client_message_after_bid', authors },
    }
  // The first message of our side is the bid itself; after it only the series, or the site's own lines, may stand.
  if (foreignOurs(messages, sent, job.followUps))
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
      // The series follows a bid: the site's own lines may come after the chat was read, and it is typed at once.
      afterOwn: true,
      quick: true,
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

/** Step: the row of an unsure message goes back to the queue, with the last message the chat shows now. */
async function requeue(id: string, expectLast: string | null): Promise<void> {
  await d()
    .db.update(outbox)
    .set({
      state: 'queued',
      errorClass: null,
      payload: sql`${outbox.payload} || ${JSON.stringify({ expectLast })}::jsonb`,
    })
    .where(and(eq(outbox.id, id), eq(outbox.state, 'uncertain')))
}

/** Step: the message is in the chat already (it went, the answer was lost): the row is confirmed. */
async function confirmFound(id: string, chatId: string, text: string, job: SeriesJob) {
  const messages = await d()
    .profi.readChat(job.accountId, chatId)
    .then((r) => r.messages)
    .catch(() => [])
  const want = normalizeText(text)
  if (!messages.some((m) => m.author === 'specialist' && normalizeText(m.text) === want))
    return false
  await d()
    .db.update(outbox)
    .set({ state: 'confirmed', errorClass: null, confirmedAt: new Date().toISOString() })
    .where(eq(outbox.id, id))
  return true
}

type Stop = { why: SeriesStop; detail?: StopDetail }

/**
 * A message the node could not answer for (UNCERTAIN: it restarted, the answer was lost; 01.11.2026 order 95618022
 * lost its call offer and Telegram so): wait, read the chat again, and if the message is not in it send it again under
 * the same key (the node presses a key once; a repeat only looks). Only a client's word, a conversation that became
 * Boris's or a refusal that does not heal stops it.
 */
async function sendUnsure(
  job: SeriesJob,
  n: number,
  text: string,
  sent: string[],
  id: string,
  chatId: string,
): Promise<Stop | null> {
  const waits = d().unsureWaitsMs
  for (let k = 0; k < waits.length; k++) {
    await DBOS.sleep(waits[k] ?? 0)
    if (
      await DBOS.runStep(() => confirmFound(id, chatId, text, job), {
        name: `found-${n}-${k}`,
        ...DB_STEP,
      })
    )
      return null
    const g = await DBOS.runStep(() => groundSeries(job, sent), {
      name: `reground-${n}-${k}`,
      ...DB_STEP,
    })
    if (!g.go) return { why: g.why, detail: g.detail }
    await DBOS.runStep(() => requeue(id, g.expectLast), { name: `requeue-${n}-${k}`, ...DB_STEP })
    const r = await DBOS.runStep(() => deliverMessage(d(), id), {
      name: `redeliver-${n}-${k}`,
      ...DB_STEP,
    })
    if (r === 'confirmed') return null
    // A refusal that does not heal (the session is dead, the chat is gone) is final; a changed chat or another
    // unsure answer is tried again.
    if (r === 'failed') return { why: 'not_sent', detail: { rule: 'delivery_failed', authors: [] } }
  }
  return { why: 'not_sent', detail: { rule: 'delivery_uncertain_after_retries', authors: [] } }
}

async function sendOne(
  job: SeriesJob,
  n: number,
  text: string,
  sent: string[],
): Promise<Stop | null> {
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
    // A series taken up again meets the row of its unsent message as it was left: back to the queue.
    if (await DBOS.patch('series-revive'))
      await DBOS.runStep(() => requeue(id, g.expectLast), {
        name: `revive-${n}${again ? '-again' : ''}`,
        ...DB_STEP,
      })
    const r = await DBOS.runStep(() => deliverMessage(d(), id), {
      name: `deliver-${n}${again ? '-again' : ''}`,
      ...DB_STEP,
    })
    if (r === 'confirmed') return null
    if (r === 'uncertain' && (await DBOS.patch('series-unsure-retry')))
      return sendUnsure(job, n, text, sent, id, g.chatId)
    if (r !== 'changed') return { why: 'not_sent', detail: { rule: `delivery_${r}`, authors: [] } }
  }
  return { why: 'not_sent', detail: { rule: 'chat_changed_twice', authors: [] } }
}

async function runSeries(job: SeriesJob): Promise<void> {
  // A series taken up again at `from`: what went before counts as sent (the call offer is known by its template).
  const from = job.from ?? 0
  const sent: string[] = job.followUps.slice(0, from)
  for (let n = from; n < job.followUps.length; n++) {
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
    // The topic shows the whole talk with the client, the series included (Boris, 01.11). Behind a patch.
    if (text && (await DBOS.patch('bid-series-topic')))
      await DBOS.runStep(() => showInTopic(job, text, n + 1), { name: `topic-${n}` })
  }
  if (await DBOS.patch('bid-series-status'))
    await DBOS.runStep(() => status(job, sent.length), { name: 'status-done' })
}

/** Step: a message of the series, short, in the client's topic; nothing without a forum, and it never throws. */
async function showInTopic(job: SeriesJob, text: string, n: number): Promise<void> {
  try {
    const notifier = d().notifier
    if (!notifier || !(await notifier.forumOn?.())) return
    await notifier.sendText(
      seriesPost({ at: new Date().toISOString(), text, n, total: job.followUps.length }),
      { html: true, quiet: true, place: { order: job.leadId } },
    )
    await markShown(d().db, job.leadId, `series:${n}`)
  } catch (e) {
    console.error('series not shown in the topic', e instanceof Error ? e.message.slice(0, 200) : e)
  }
}

/** Step: the line about the series goes under the status message of the bid (one message for the whole bid). */
async function status(job: SeriesJob, sent: number, why?: SeriesStop): Promise<void> {
  await addStatusLine(job.leadId, seriesLine(sent, why, job.followUps.length)).catch(() => {})
}

const seriesWorkflow = DBOS.registerWorkflow(runSeries, { name: 'bidSeries' })

/** Starts the series of a confirmed bid; a second start for the same order is the process there is. */
export async function startSeries(job: SeriesJob): Promise<void> {
  if (job.followUps.length === 0) return
  await DBOS.startWorkflow(seriesWorkflow, { workflowID: seriesWorkflowId(job.leadId) })(job)
}

/** How long after it stopped on a delivery that did not go a series is taken up again when the core starts. */
const RESUME_WITHIN_MS = 6 * 3600_000

/**
 * On start: a series that stopped because a message did not go (the node was restarting, 01.11.2026) is taken up again
 * at the message where it stopped, once, for six hours after. The chat is read first like before any message, so a
 * client who answered meanwhile, or Boris who wrote himself, stops it as ever.
 */
export async function resumeStoppedSeries(db: Db): Promise<number> {
  const stopped = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.type, 'bid.series_stopped'),
        gt(event.occurredAt, new Date(Date.now() - RESUME_WITHIN_MS).toISOString()),
        sql`${event.payload}->>'why' = 'not_sent'`,
      ),
    )
  let started = 0
  for (const e of stopped) {
    const n = Number((e.payload as { n?: number }).n)
    if (!Number.isInteger(n) || !e.accountId) continue
    const [bid] = await db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(and(eq(outbox.kind, 'bid'), sql`${outbox.payload}->>'leadId' = ${e.entityId}`))
    const followUps = (bid?.payload as { followUps?: string[] } | undefined)?.followUps ?? []
    if (followUps.length <= n) continue
    await DBOS.startWorkflow(seriesWorkflow, {
      workflowID: `bid-series-resume:${e.entityId}:${n}`,
    })({
      leadId: e.entityId,
      accountId: e.accountId,
      correlationId: e.correlationId,
      followUps,
      from: n,
    })
    started++
  }
  return started
}
