import { DBOS } from '@dbos-inc/dbos-sdk'
import { shownTitle } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { lead } from '../db/schema'
import type { Notifier } from '../notify/notifier'
import { deliverMessage } from './outbox'
import { answerOf, groundJob, queueJob, type SendDeps, settleJob } from './sendJob'
import { SEND_TEXTS, type SendJob, type SendOutcome } from './sendTexts'
import { getConversation } from './store'
import { CONV_TEXTS } from './texts'

/**
 * The send of a text to a client as a durable process `convSend` (review of the drafts mode): a press on «Отправить»
 * answers Boris at once, and the work (the reread of the chat, the queue, a delivery that may take minutes, the card it
 * settles) runs here, keyed by the press (`conv-send:<key>`), so the bot is never held and Telegram never drops the
 * answer. A restart in the middle goes on from the recorded steps: the outbox row is there once per key and the
 * delivery asks the service with the same key, which never sends twice. The result reaches Boris as a new message.
 */

export type SendFlowDeps = SendDeps & {
  notifier: Pick<Notifier, 'sendText'>
  /** The text reached the client: the discussion of it leaves the topic (the topic chat spec, section 5). */
  onSent?(conversationId: string): Promise<unknown>
}

let deps: SendFlowDeps | null = null

const d = (): SendFlowDeps => {
  if (!deps) throw new Error('the send process is not configured')
  return deps
}

export function setSendDeps(x: SendFlowDeps): void {
  deps = x
}

export const sendWorkflowId = (key: string) => `conv-send:${key}`

const DB_STEP = { retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2 }

/** Whose message it is, for the line that tells Boris how it went. */
async function whoOf(job: SendJob): Promise<{ name: string | null; title: string | null }> {
  const conv = await getConversation(d().db, job.conversationId)
  const [l] = conv?.orderId ? await d().db.select().from(lead).where(eq(lead.id, conv.orderId)) : []
  return { name: l?.clientName || null, title: l ? shownTitle(l.id, l.title) : null }
}

async function tell(job: SendJob, text: string): Promise<void> {
  const who = await whoOf(job)
  await d().notifier.sendText(CONV_TEXTS.sendResult(who.name, who.title, text), {
    place: { conversation: job.conversationId },
  })
}

async function runSend(job: SendJob): Promise<void> {
  if (job.notBefore) {
    const wait = Date.parse(job.notBefore) - (await DBOS.now())
    if (wait > 0) await DBOS.sleep(wait)
  }
  const g = await DBOS.runStep(() => groundJob(d(), job), { name: 'ground', ...DB_STEP })
  let outcome: SendOutcome
  if ('outcome' in g) outcome = g.outcome
  else {
    const id = await DBOS.runStep(() => queueJob(d().db, job, g.expectLast), {
      name: 'queue',
      ...DB_STEP,
    })
    outcome = id
      ? answerOf(await DBOS.runStep(() => deliverMessage(d(), id), { name: 'deliver', ...DB_STEP }))
      : { kind: 'answer', answer: SEND_TEXTS.notNow }
  }
  const text = await DBOS.runStep(() => settleJob(d().db, job, outcome), {
    name: 'settle',
    ...DB_STEP,
  })
  try {
    await DBOS.runStep(() => tell(job, text), { name: 'tell', ...DB_STEP })
  } catch (e) {
    // The text has gone or been refused all the same: a message to Boris that Telegram would not take is not a failure.
    console.error('send: Boris was not told', e instanceof Error ? e.message : e)
  }
  // Not a step: the clearing is done once whoever runs it (the topic showing our message does it too).
  if (outcome.kind === 'answer' && outcome.answer === SEND_TEXTS.sent)
    await d()
      .onSent?.(job.conversationId)
      .catch(() => {})
}

const sendWorkflow = DBOS.registerWorkflow(runSend, { name: 'convSend' })

/**
 * Starts the send of a job and answers at once. A repeat start with the same key (a callback delivered twice) is the
 * process there is, never a second one.
 */
export async function startSendJob(job: SendJob): Promise<string> {
  await DBOS.startWorkflow(sendWorkflow, { workflowID: sendWorkflowId(job.key) })(job)
  return SEND_TEXTS.sending
}
