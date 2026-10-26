import { DBOS } from '@dbos-inc/dbos-sdk'
import { and, eq, inArray, like, notLike } from 'drizzle-orm'
import { convTurn, deal, task } from '../db/schema'
import { TransitionError, transition } from '../domain/deal'
import { getSetting } from '../settings/store'
import { clientTurnBefore, isRefusal } from './clientCues'
import {
  checkGround,
  dormantStep,
  fallbackStep,
  type Ground,
  giveUpCard,
  giveUpDormant,
  groundStep,
  isLadderMessage,
  ladderTexts,
  type Planned,
  planNext,
  quietUntil,
  REFUSED,
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

/** Steps of the ladder: three reminders and the silence task; the loop stops at the task. */
const MAX_PLANS = 5
/** A model that gave no text is asked again every so often until the reminder is that late (design 5.11). */
const FALLBACK_AFTER_MS = 3 * 3600_000
const RETRY_EVERY_MS = 10 * 60_000
/** The silence task is tried every hour for a day while something stands in its way, soon again after a failure. */
const DORMANT_TRIES = 24
const DORMANT_RETRY_MS = 3600_000
const DORMANT_STEP_RETRY_MS = 10 * 60_000
const DB_STEP = { retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2 }
/** The card of a reminder that Telegram would not take is tried again every 10 minutes, 6 times, then given up. */
const CARD_TRIES = 6
const CARD_RETRY_MS = 10 * 60_000

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
  // How many steps are done, and when the one before went (or was due, if it was only skipped): the next wait
  // counts from there (rule 11: 1 day, then 2 days after the first, 3 days after the second, 3 days after the third).
  let sent = 0
  let prevAt: string | null = null
  for (let k = 0; k < MAX_PLANS; k++) {
    const next = await DBOS.runStep(() => planNext(d(), conversationId, anchor, { sent, prevAt }), {
      name: `plan-${k}`,
      ...DB_STEP,
    })
    if (!next) return
    const wait = Date.parse(next.at) - (await DBOS.now())
    if (wait > 0) await DBOS.sleep(wait)
    const rowId = `${wf}:${next.step}`
    if (next.step === 'dormant') {
      // The third reminder is the last: three silent days later Boris gets one task (in shadow only the trace) and the
      // ladder is over. Nothing waits for his answer, «Закрыть» works on the task whenever he presses it.
      await askBoris(k, conversationId, anchor, rowId, next)
      return
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
      prevAt = next.at
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
    let result = await DBOS.runStep(
      () => sendStep(d(), rowId, conversationId, anchor, next, text),
      { name: `send-${k}`, ...DB_STEP },
    )
    // Drafts mode: Telegram not taking the card is a passing trouble, the step is tried again for an hour.
    for (let a = 1; result.retry; a++) {
      if (a >= (d().cardTries ?? CARD_TRIES)) {
        await DBOS.runStep(() => giveUpCard(d(), rowId), {
          name: `card-giveup-${k}`,
          ...DB_STEP,
        })
        result = { outcome: 'failed', end: false }
        break
      }
      await DBOS.sleep(d().cardRetryEveryMs ?? CARD_RETRY_MS)
      result = await DBOS.runStep(() => sendStep(d(), rowId, conversationId, anchor, next, text), {
        name: `send-${k}-r${a}`,
        ...DB_STEP,
      })
    }
    if (result.end) return
    prevAt =
      result.outcome === 'sent' ||
      result.outcome === 'drafted' ||
      result.outcome === 'carded' ||
      result.outcome === 'uncertain'
        ? new Date(await DBOS.now()).toISOString()
        : next.at
    sent++
  }
}

/**
 * A ladder lives for weeks, and DBOS counts every restart that finds a process unfinished as a recovery attempt; the
 * default of 100 would send a long-sleeping process to the dead-letter queue after enough deploys.
 */
export const REMIND_MAX_RECOVERY_ATTEMPTS = 10_000

const remindWorkflow = DBOS.registerWorkflow(runRemind, {
  name: 'convRemind',
  maxRecoveryAttempts: REMIND_MAX_RECOVERY_ATTEMPTS,
})

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

/**
 * The chat read again before the text of a reminder card goes to the client, hours after the card came (a press of
 * Boris, FR-CONV-12): the same last word as at the wake-up of the step.
 */
export async function reminderGround(conversationId: string, anchor: string): Promise<Ground> {
  return checkGround(d(), conversationId, anchor, { dormant: false })
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
 * The task for Boris about a quiet client, and the card of a reminder that still waits for his press, are moot once
 * the client or our side wrote: they are closed. The tasks of the process `keep` (the one that goes on) stay.
 */
async function resolveDormantTasks(conversationId: string, keep?: string) {
  const closed = await d()
    .db.update(task)
    .set({ state: 'resolved', resolution: 'answered', resolvedAt: new Date().toISOString() })
    .where(
      and(
        inArray(task.kind, ['conv_dormant', 'conv_draft']),
        like(task.entityId, `conv-remind:${conversationId}:%`),
        keep ? notLike(task.entityId, `${keep}:%`) : undefined,
        eq(task.state, 'open'),
      ),
    )
    .returning({ rowId: task.entityId, kind: task.kind })
  for (const c of closed)
    if (c.kind === 'conv_draft')
      await d()
        .db.update(convTurn)
        .set({ outcome: 'answered', decisionReason: 'разговор пошёл дальше: напоминание не нужно' })
        .where(and(eq(convTurn.id, c.rowId), eq(convTurn.outcome, 'carded')))
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
  if (fresh.closedAt || fresh.owner !== 'sara') {
    // Closed, or Boris leads the client: the processes end, and so does the task that asks him about the client.
    await cancelReminders(conv.id)
    await resolveDormantTasks(conv.id)
    return
  }
  // Conversations or reminders switched off: nothing new starts (startReminder), what waits goes on waiting and
  // skips its steps while the switch is off.
  if (
    !(await getSetting(db, 'pipeline.conversations')) ||
    !(await getSetting(db, 'conv.reminders'))
  )
    return
  // The ladder's own reminders stand in the chat as our side's messages and are not a new beginning.
  const ladder = await ladderTexts(db, conv.id)
  const anchor = messages.findLast((m) => m.side === 'specialist' && !isLadderMessage(m, ladder))
  if (!anchor) return
  const wf = remindWorkflowId(conv.id, anchor.platformMessageId)
  // The client said no: no ladder, the code decides it. Nothing waits for an older message either.
  const turn = clientTurnBefore(
    messages.map((m) => ({ id: m.platformMessageId, side: m.side, text: m.text })),
    anchor.platformMessageId,
  )
  if (isRefusal(turn)) {
    await cancelReminders(conv.id)
    await resolveDormantTasks(conv.id)
    await traceRefusal(conv.id, anchor.platformMessageId, wf)
    return
  }
  if ((await cancelReminders(conv.id, { keep: wf })) > 0) await resolveDormantTasks(conv.id, wf)
  await startReminder(conv.id, anchor.platformMessageId)
}

/** The only trace of a ladder that was not run: one row, whatever the shadow or the switch (a repeat adds none). */
async function traceRefusal(conversationId: string, anchor: string, wf: string): Promise<void> {
  const now = new Date().toISOString()
  await d()
    .db.insert(convTurn)
    .values({
      id: `${wf}:refused`,
      conversationId,
      kind: 'reminder',
      anchorMessageId: anchor,
      state: 'finished',
      outcome: 'stopped',
      decision: 'nothing',
      decisionReason: REFUSED,
      understanding: { step: 'refused' },
      timings: { finished: now },
      finishedAt: now,
    })
    .onConflictDoNothing()
}
