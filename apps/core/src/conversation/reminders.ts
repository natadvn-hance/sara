import { DBOS } from '@dbos-inc/dbos-sdk'
import { and, eq, like, notLike } from 'drizzle-orm'
import { deal, task } from '../db/schema'
import { TransitionError, transition } from '../domain/deal'
import { getSetting } from '../settings/store'
import {
  dormantStep,
  expireDormantTask,
  fallbackStep,
  giveUpDormant,
  groundStep,
  isLadderMessage,
  ladderTexts,
  type Planned,
  planNext,
  quietUntil,
  type RemindDeps,
  sendStep,
  writeStep,
} from './reminderSteps'
import { getConversation } from './store'
import type { ConversationRow, StoredMessage } from './types'

export {
  type NextReminder,
  nextReminder,
  type ReminderStep,
  type ReminderTone,
  reminderFallback,
} from './reminderLadder'
export type { RemindDeps } from './reminderSteps'

/**
 * Reminders to a client who went quiet after our side's message (FR-CONV-12, M4 design 5.11): the durable process
 * `convRemind`, one per message of ours that the client did not answer. It sleeps until the step is due, looks at
 * the chat again and goes only if nobody wrote since; in shadow it only records the draft. The ladder itself is in
 * reminderLadder.ts, the checks and the send in reminderSteps.ts.
 */

let deps: RemindDeps | null = null

const d = (): RemindDeps => {
  if (!deps) throw new Error('reminders are not configured')
  return deps
}

export function setRemindDeps(x: RemindDeps): void {
  deps = x
}

export const remindWorkflowId = (conversationId: string, anchor: string) =>
  `conv-remind:${conversationId}:${anchor}`

/** Steps of the ladder: a day, three days, dormant, ten days, thirty days; the loop stops long before this. */
const MAX_PLANS = 8
/** A model that gave no text is asked again every so often until the reminder is that late (design 5.11). */
const FALLBACK_AFTER_MS = 3 * 3600_000
const RETRY_EVERY_MS = 10 * 60_000
/** Boris has this long to answer the task of a dormant client; with no answer the ladder ends. */
const DORMANT_WAIT_S = 30 * 24 * 3600
/** The dormant day is tried every hour for a day while something stands in its way, soon again after a failure. */
const DORMANT_TRIES = 24
const DORMANT_RETRY_MS = 3600_000
const DORMANT_STEP_RETRY_MS = 10 * 60_000
const DB_STEP = { retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2 }

/**
 * The text of a reminder: the model's; when the model itself gave nothing (a limit, a failure) it is asked again every
 * so often until the reminder is 3 hours late; when its text failed the checks twice, or the time is up, the ready
 * text of old Sara goes.
 */
async function obtainText(
  k: number,
  conversationId: string,
  rowId: string,
  p: Planned,
  read: boolean,
): Promise<string> {
  const deadline = (await DBOS.now()) + (d().fallbackAfterMs ?? FALLBACK_AFTER_MS)
  for (let a = 0; ; a++) {
    const left = deadline - (await DBOS.now())
    if (left <= 0) break
    const w = await DBOS.runStep(() => writeStep(d(), rowId, conversationId, p, read, left), {
      name: `write-${k}-${a}`,
    })
    if (w.text) return w.text
    // The checks failed twice: the model is not asked again, the ready text goes.
    if (!w.modelFailed) break
    const wait = Math.min(d().retryEveryMs ?? RETRY_EVERY_MS, deadline - (await DBOS.now()))
    if (wait > 0) await DBOS.sleep(wait)
  }
  const f = await DBOS.runStep(() => fallbackStep(d(), rowId, conversationId, p), {
    name: `fallback-${k}`,
    ...DB_STEP,
  })
  return f.text
}

/**
 * The dormant day goes to Boris, and it is not lost for a passing trouble: while something stands in the way (a turn
 * runs, a meeting service does not answer) it is tried every hour for a day, and a failure of the step itself, Telegram
 * being down say, is tried again soon, like a turn's steps. The chat is not read for it, it is no message to the client.
 * 'end': the ladder is over; 'shadow': only the trace says so; 'asked': Boris has his task.
 */
async function askBoris(
  k: number,
  conversationId: string,
  anchor: string,
  rowId: string,
  p: Planned,
): Promise<'asked' | 'shadow' | 'end'> {
  let why = 'не вышло'
  for (let a = 0; a < (d().dormantTries ?? DORMANT_TRIES); a++) {
    const g = await DBOS.runStep(
      () => groundStep(d(), rowId, conversationId, anchor, p, { retry: true }),
      { name: `ground-${k}-${a}`, ...DB_STEP },
    )
    if (!g.go && g.end) return 'end'
    if (g.go) {
      try {
        const t = await DBOS.runStep(() => dormantStep(d(), rowId, conversationId, g.shadow), {
          name: `dormant-${k}-${a}`,
        })
        return t.asked ? 'asked' : 'shadow'
      } catch (e) {
        why = 'Telegram не отвечает'
        console.error('reminder: the dormant task did not go', e instanceof Error ? e.message : e)
        await DBOS.sleep(d().dormantStepRetryMs ?? DORMANT_STEP_RETRY_MS)
        continue
      }
    }
    why = g.why
    await DBOS.sleep(d().dormantRetryEveryMs ?? DORMANT_RETRY_MS)
  }
  await DBOS.runStep(() => giveUpDormant(d(), rowId, why), {
    name: `dormant-giveup-${k}`,
    ...DB_STEP,
  })
  return 'end'
}

async function runRemind(conversationId: string, anchor: string): Promise<void> {
  const wf = remindWorkflowId(conversationId, anchor)
  let sent = 0
  let continued = false
  let lastSentAt: string | null = null
  let continuedAt: string | null = null
  for (let k = 0; k < MAX_PLANS; k++) {
    const next = await DBOS.runStep(
      () => planNext(d(), conversationId, anchor, { sent, continued, lastSentAt, continuedAt }),
      { name: `plan-${k}`, ...DB_STEP },
    )
    if (!next) return
    const wait = Date.parse(next.at) - (await DBOS.now())
    if (wait > 0) await DBOS.sleep(wait)
    const rowId = `${wf}:${next.step}`
    if (next.step === 'dormant') {
      // Shadow has nobody to ask: the ladder ends at the dormant day.
      if ((await askBoris(k, conversationId, anchor, rowId, next)) !== 'asked') return
      const answer = await DBOS.recv<string>('decision', {
        timeoutSeconds: d().dormantWaitS ?? DORMANT_WAIT_S,
      })
      if (answer !== 'remind') {
        // No answer in the whole time: the task is closed, not left open with buttons that promise what will not come.
        if (answer === null)
          await DBOS.runStep(() => expireDormantTask(d(), rowId), {
            name: `dormant-expire-${k}`,
            ...DB_STEP,
          })
        return
      }
      continued = true
      // «Через 10 суток» is true from the moment he pressed, not from the dormant day.
      continuedAt = new Date(await DBOS.now()).toISOString()
      continue
    }
    const g = await DBOS.runStep(() => groundStep(d(), rowId, conversationId, anchor, next), {
      name: `ground-${k}`,
      ...DB_STEP,
    })
    if (!g.go) {
      // The client wrote, our side wrote, a pause: the ladder ends. A step only skipped (a running turn, an
      // unreadable chat, a pause of sending) is not repeated later, the next step comes at its own time.
      if (g.end) return
      sent++
      continue
    }
    const text = await obtainText(k, conversationId, rowId, next, g.read)
    // The text may have taken hours: a reminder never goes in the quiet hours, it waits for the morning.
    const hold = await DBOS.runStep(async () => quietUntil(d(), new Date()), {
      name: `quiet-${k}`,
      ...DB_STEP,
    })
    const rest = hold.until ? Date.parse(hold.until) - (await DBOS.now()) : 0
    if (rest > 0) await DBOS.sleep(rest)
    const result = await DBOS.runStep(
      () => sendStep(d(), rowId, conversationId, anchor, next, text),
      { name: `send-${k}`, ...DB_STEP },
    )
    if (result.end) return
    if (result.outcome === 'sent' || result.outcome === 'drafted' || result.outcome === 'uncertain')
      lastSentAt = new Date(await DBOS.now()).toISOString()
    sent++
  }
}

const remindWorkflow = DBOS.registerWorkflow(runRemind, { name: 'convRemind' })

/**
 * Starts the process for our message the client did not answer: `conv-remind:<conversation>:<message>`, so a repeat
 * start returns the process there is. Nothing starts while conversations or reminders are switched off.
 */
export async function startReminder(
  conversationId: string,
  lastOursMessageId: string,
): Promise<void> {
  const { db } = d()
  if (!(await getSetting(db, 'pipeline.conversations'))) return
  if (!(await getSetting(db, 'conv.reminders'))) return
  await DBOS.startWorkflow(remindWorkflow, {
    workflowID: remindWorkflowId(conversationId, lastOursMessageId),
  })(conversationId, lastOursMessageId)
}

const OPEN = ['PENDING', 'ENQUEUED', 'DELAYED'] as const

/** The ids of the reminder processes of a conversation that are not over. */
export async function openReminders(conversationId: string): Promise<string[]> {
  const open = await DBOS.listWorkflows({
    workflow_id_prefix: `conv-remind:${conversationId}:`,
    status: [...OPEN],
  })
  return open.map((w) => w.workflowID)
}

/** Stops the waiting reminder processes of a conversation, but the one of `keep`; returns how many it stopped. */
export async function cancelReminders(
  conversationId: string,
  o: { keep?: string } = {},
): Promise<number> {
  const ids = (await openReminders(conversationId)).filter((id) => id !== o.keep)
  if (ids.length > 0) await DBOS.cancelWorkflows(ids)
  return ids.length
}

/**
 * The task for Boris about a quiet client is moot once the client or our side wrote: it is closed. The task of the
 * process `keep` (the one that goes on) stays.
 */
async function resolveDormantTasks(conversationId: string, keep?: string) {
  await d()
    .db.update(task)
    .set({ state: 'resolved', resolution: 'answered', resolvedAt: new Date().toISOString() })
    .where(
      and(
        eq(task.kind, 'conv_dormant'),
        like(task.entityId, `conv-remind:${conversationId}:%`),
        keep ? notLike(task.entityId, `${keep}:%`) : undefined,
        eq(task.state, 'open'),
      ),
    )
}

/** A client who was dormant and wrote again is in the conversation again. */
async function wakeDeal(conv: ConversationRow) {
  if (!conv.dealId) return
  const [x] = await d().db.select({ stage: deal.stage }).from(deal).where(eq(deal.id, conv.dealId))
  if (x?.stage !== 'dormant') return
  try {
    await transition(d().db, {
      dealId: conv.dealId,
      to: 'talking',
      actor: 'sara',
      reason: 'клиент снова написал',
      correlationId: conv.id,
    })
  } catch (e) {
    if (!(e instanceof TransitionError)) throw e
  }
}

/**
 * What the chat as read says about reminders (called whenever a chat is read, from the events and the 10-minute
 * check): a client's message, or a message of ours that is not one of the ladder's own, cancels the waiting process
 * of the old last message; our message last starts the process of it. Unclear authors stop everything.
 */
export async function syncReminders(
  conv: ConversationRow,
  messages: StoredMessage[],
): Promise<void> {
  if (!deps) return
  const { db } = d()
  const last = messages.findLast((m) => m.side !== 'system')
  if (!last) return
  if (last.side !== 'specialist') {
    await cancelReminders(conv.id)
    if (last.side === 'client') {
      await resolveDormantTasks(conv.id)
      await wakeDeal(conv)
    }
    return
  }
  const fresh = (await getConversation(db, conv.id)) ?? conv
  const on =
    (await getSetting(db, 'pipeline.conversations')) &&
    (await getSetting(db, 'conv.reminders')) &&
    !fresh.closedAt &&
    fresh.owner === 'sara'
  if (!on) {
    await cancelReminders(conv.id)
    await resolveDormantTasks(conv.id)
    return
  }
  // The ladder's own reminders stand in the chat as our side's messages and are not a new beginning.
  const ladder = await ladderTexts(db, conv.id)
  const anchor = messages.findLast((m) => m.side === 'specialist' && !isLadderMessage(m, ladder))
  if (!anchor) return
  const wf = remindWorkflowId(conv.id, anchor.platformMessageId)
  if ((await cancelReminders(conv.id, { keep: wf })) > 0) await resolveDormantTasks(conv.id, wf)
  await startReminder(conv.id, anchor.platformMessageId)
}

/** DBOS tells a send to a process that never existed by this code (`DBOSNonExistentWorkflowError`, not exported). */
const NON_EXISTENT_WORKFLOW = 16
const isMissingWorkflow = (e: unknown) =>
  (e as { dbosErrorCode?: number } | null)?.dbosErrorCode === NON_EXISTENT_WORKFLOW

/** Boris's answer on the dormant task reaches the process that waits for it (a process that is gone is fine). */
export async function decideDormant(
  reminderTurnId: string,
  decision: 'remind' | 'close',
): Promise<boolean> {
  const wf = reminderTurnId.slice(0, reminderTurnId.lastIndexOf(':'))
  // Only a process that still waits can be told; the caller says so plainly to Boris when it does not.
  if ((await DBOS.getWorkflowStatus(wf))?.status !== 'PENDING') return false
  try {
    await DBOS.send(wf, decision, 'decision', `dormant:${reminderTurnId}:${decision}`)
    return true
  } catch (e) {
    // DBOS names this error by its class only in the code: the error object's `name` is plain «Error».
    if (!isMissingWorkflow(e)) throw e
    return false
  }
}
