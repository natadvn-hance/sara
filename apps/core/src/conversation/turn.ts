import { DBOS } from '@dbos-inc/dbos-sdk'
import { newEventId, type Topic } from '@sara/shared'
import { asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { account, chatMessage, convTurn, mindGap } from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import { appendEvent } from '../journal/journal'
import type { ProfiClient } from '../profi/client'
import { getSetting } from '../settings/store'
import { buildDossier, turnMessageIds } from './dossier'
import { planTurn } from './engine'
import { applyOwnerRule, getConversation, updateConversation } from './store'
import { storedOf, syncChat } from './sync'
import { humanPauseMs, quietLeftSeconds } from './timing'
import type { ConversationRow, Decision, MindSearch, PolicySettings, StoredMessage } from './types'

export type TurnDeps = {
  db: Db
  profi: ProfiClient
  gateway: Gateway
  mind: MindSearch
  /** The card of a decided turn to Boris: the shadow draft, a draft, a call (part C4). */
  card(turnId: string): Promise<void>
  /** The client's words to Boris: a client he took, a closed conversation. */
  forward(turnId: string): Promise<void>
  /** A reply to the client after the switch (part C6); 'changed' when the chat moved on. */
  send(turnId: string, round: number): Promise<'confirmed' | 'changed' | 'uncertain' | 'failed'>
  /** The human pause; tests shorten it. */
  pauseMs?(textLength: number): number
}

let deps: TurnDeps | null = null
const d = (): TurnDeps => {
  if (!deps) throw new Error('turns are not configured')
  return deps
}

export function setTurnDeps(x: TurnDeps): void {
  deps = x
}

export const turnWorkflowId = (conversationId: string, anchor: string) =>
  `conv-turn:${conversationId}:${anchor}`

/** A turn plans again at most this many times when the client writes before the reply goes (FR-CONV-6). */
const MAX_ROUNDS = 3
/** Night holds before a turn gives up and drafts. */
const MAX_HOLDS = 2
/** Wake-ups while waiting for the client to finish; the wait itself is capped by conv.max_wait_s. */
const MAX_WAKES = 200
/** An unreadable chat is retried every minute for half an hour. */
const UNREADABLE_TRIES = 30
const DB_STEP = { retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2 }

type Gate = 'go' | 'closed' | 'take' | 'answered' | 'unclear' | 'unreadable'
type Heard = { gate: Gate; quietLeftS: number }
type Planned = {
  action: Decision['action']
  holdUntil: string | null
  text: string | null
  covered: string[]
}

async function stamp(
  turnId: string,
  step: string,
  patch: Partial<typeof convTurn.$inferInsert> = {},
) {
  await d()
    .db.update(convTurn)
    .set({
      ...patch,
      timings: sql`${convTurn.timings} || ${JSON.stringify({ [step]: new Date().toISOString() })}::jsonb`,
    })
    .where(eq(convTurn.id, turnId))
}

async function journal(
  type:
    | 'conv.turn_started'
    | 'conv.turn_drafted'
    | 'conv.turn_sent'
    | 'conv.turn_cancelled'
    | 'conv.turn_failed',
  conv: ConversationRow,
  turnId: string,
  payload: Record<string, unknown> = {},
) {
  await appendEvent(d().db, {
    type,
    v: 1,
    entity: { kind: 'conv_turn', id: turnId },
    account_id: conv.accountId,
    actor: 'sara',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: conv.id,
    reason: null,
    payload: { conversation_id: conv.id, ...payload },
  })
}

/** Step «start»: the trace row, once (the workflow id is the row id). Returns when the turn began. */
async function startRow(turnId: string, conversationId: string, anchor: string): Promise<string> {
  const conv = await getConversation(d().db, conversationId)
  if (!conv) throw new Error(`conversation ${conversationId} not found`)
  const now = new Date().toISOString()
  const rows = await d()
    .db.insert(convTurn)
    .values({
      id: turnId,
      conversationId,
      anchorMessageId: anchor,
      state: 'waiting',
      timings: { started: now },
    })
    .onConflictDoNothing()
    .returning({ id: convTurn.id })
  if (rows.length) await journal('conv.turn_started', conv, turnId, { anchor })
  const [row] = await d()
    .db.select({ timings: convTurn.timings })
    .from(convTurn)
    .where(eq(convTurn.id, turnId))
  return (row?.timings as { started?: string })?.started ?? now
}

/** Step 1 «услышать»: read the chat, apply the owner rule, decide whether to wait, go or stop. */
async function hear(
  turnId: string,
  conversationId: string,
  anchor: string,
  startedAt: string,
): Promise<Heard> {
  const db = d().db
  let conv = await getConversation(db, conversationId)
  if (!conv) return { gate: 'closed', quietLeftS: 0 }
  const v1Writes = await getSetting(db, 'conv.v1_writes')
  let r: Awaited<ReturnType<typeof syncChat>>
  try {
    r = await syncChat(d(), conv, new Date(), { v1Writes })
  } catch (e) {
    console.error('turn: chat unreadable', e instanceof Error ? e.message : e)
    return { gate: 'unreadable', quietLeftS: 0 }
  }
  conv = await applyOwnerRule(db, conv, r.added, { v1Writes })
  await stamp(turnId, 'heard')
  if (conv.closedAt) return { gate: 'closed', quietLeftS: 0 }
  if (conv.owner === 'boris' && conv.ownerReason === 'take') return { gate: 'take', quietLeftS: 0 }
  if (r.unclear) return { gate: 'unclear', quietLeftS: 0 }
  const at = r.messages.findIndex((m) => m.platformMessageId === anchor)
  if (at >= 0 && r.messages.slice(at).some((m) => m.side === 'specialist'))
    return { gate: 'answered', quietLeftS: 0 }
  const quietLeftS = quietLeftSeconds(
    conv,
    {
      quietAfterMessageS: await getSetting(db, 'conv.quiet_after_message_s'),
      quietAfterTypingS: await getSetting(db, 'conv.quiet_after_typing_s'),
      maxWaitS: await getSetting(db, 'conv.max_wait_s'),
    },
    new Date(startedAt),
    new Date(),
  )
  return { gate: 'go', quietLeftS }
}

async function policySettings(db: Db, accountId: string): Promise<PolicySettings> {
  const [a] = await db.select().from(account).where(eq(account.id, accountId))
  return {
    v1Writes: await getSetting(db, 'conv.v1_writes'),
    outboundMessages: await getSetting(db, 'outbound.messages'),
    accountPaused: a ? a.paused || a.loginState === 'dead' || a.loginState === 'banned' : false,
    night: await getSetting(db, 'conv.night'),
    autonomy: (await getSetting(db, 'conv.autonomy')) as Record<Topic, 'self' | 'draft' | 'call'>,
  }
}

/** Steps 2-6 in one DBOS step: the model call is not repeated by a replay. Every failure becomes a draft. */
async function planStep(turnId: string, conversationId: string): Promise<Planned> {
  const { db, gateway, mind, profi } = d()
  const now = new Date()
  const conv = await getConversation(db, conversationId)
  if (!conv) return { action: 'nothing', holdUntil: null, text: null, covered: [] }
  try {
    const settings = await policySettings(db, conv.accountId)
    const dossier = await buildDossier(db, conversationId, now, { night: settings.night, profi })
    await stamp(turnId, 'recalled', { messageIds: dossier.turnMessageIds })
    const plan = await planTurn(
      { gateway, mind },
      { dossier, names: dossier.clientName ? [dossier.clientName] : [], settings, now },
    )
    const out = plan.output
    await stamp(turnId, 'planned', {
      mindVersion: plan.recall.mindVersion,
      recalled: {
        understanding: plan.recall.understanding.map((h) => h.id),
        knowledge: plan.recall.knowledge.map((h) => h.id),
        examples: plan.recall.examples.map((h) => h.id),
        procedure: plan.recall.procedure?.id ?? null,
        always: plan.recall.always.map((h) => h.id),
      },
      understanding: out
        ? {
            heard: out.heard,
            question_type: out.question_type,
            topic: out.topic,
            tone: out.tone,
            why: out.why,
          }
        : null,
      move: out?.move ?? null,
      urgent: out?.urgent ?? false,
      text: out?.text ?? null,
      factIds: out?.fact_ids ?? [],
      exampleIds: out?.example_ids ?? [],
      missing: out?.missing ?? null,
      checks: {
        issues: plan.issues,
        attempts: plan.attempts,
        checker: plan.checkerRan,
        failure: plan.failure,
      },
      modelCallIds: plan.modelCallIds,
    })
    if (out?.missing)
      await db
        .insert(mindGap)
        .values({ id: newEventId(), turnId, text: out.missing, topic: out.topic })
    await stamp(turnId, 'decided', {
      decision: plan.decision.action,
      decisionReason: plan.decision.reason,
      state: 'decided',
    })
    return {
      action: plan.decision.action,
      holdUntil: plan.decision.holdUntil,
      text: out?.text ?? null,
      covered: dossier.turnMessageIds,
    }
  } catch (e) {
    console.error('turn: planning failed', e instanceof Error ? e.message : e)
    await stamp(turnId, 'decided', {
      decision: 'draft',
      decisionReason: 'не смогла подготовить ответ',
      state: 'decided',
    })
    return { action: 'draft', holdUntil: null, text: null, covered: [] }
  }
}

/** Step 7 before sending: did the client write more, or did our side answer, since the plan? */
async function reread(
  conversationId: string,
  anchor: string,
  covered: string[],
): Promise<'same' | 'more' | 'answered'> {
  const { db } = d()
  const conv = await getConversation(db, conversationId)
  if (!conv) return 'answered'
  const v1Writes = await getSetting(db, 'conv.v1_writes')
  const r = await syncChat(d(), conv, new Date(), { v1Writes })
  await applyOwnerRule(db, conv, r.added, { v1Writes })
  const at = r.messages.findIndex((m) => m.platformMessageId === anchor)
  const after = at >= 0 ? r.messages.slice(at) : r.messages
  if (after.some((m) => m.side === 'specialist')) return 'answered'
  const known = new Set(covered)
  return after.some((m) => m.side === 'client' && !known.has(m.platformMessageId)) ? 'more' : 'same'
}

const OUTCOME_EVENT = {
  drafted: 'conv.turn_drafted',
  called_boris: 'conv.turn_drafted',
  forwarded: 'conv.turn_drafted',
  sent: 'conv.turn_sent',
  no_reply: 'conv.turn_drafted',
  answered: 'conv.turn_cancelled',
  unclear: 'conv.turn_cancelled',
  closed: 'conv.turn_cancelled',
  failed: 'conv.turn_failed',
} as const
type Outcome = keyof typeof OUTCOME_EVENT

/** Step «handoff»: the turn ends, marks what it answered and starts the next turn for what it did not see. */
async function handoff(
  turnId: string,
  conversationId: string,
  anchor: string,
  outcome: Outcome,
  covered: string[],
): Promise<string | null> {
  const { db } = d()
  let conv = await getConversation(db, conversationId)
  if (!conv) return null
  const messages = await storedMessages(db, conversationId)
  // A turn that answered nothing on purpose (Boris's client, an unclear author) still covers what it saw.
  const through =
    covered.at(-1) ??
    (outcome === 'forwarded' || outcome === 'unclear' || outcome === 'closed'
      ? messages.findLast((m) => m.side === 'client')?.platformMessageId
      : undefined)
  if (through) conv = await updateConversation(db, conversationId, { handledThrough: through })
  await stamp(turnId, 'finished', {
    state: 'finished',
    outcome,
    finishedAt: new Date().toISOString(),
  })
  await journal(OUTCOME_EVENT[outcome], conv, turnId, { outcome })
  const next = turnMessageIds(messages, conv.handledThrough)[0] ?? null
  return next && next !== anchor ? next : null
}

async function storedMessages(db: Db, conversationId: string): Promise<StoredMessage[]> {
  const rows = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.conversationId, conversationId))
    .orderBy(asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))
  return rows.map(storedOf)
}

/**
 * One turn of the conversation: Sara's answer to one client turn (FR-CONV-3, M4 design 5.5, 5.7). It waits while the
 * client writes, plans in one step, holds at night, and after the switch pauses like a human, rereads the chat and
 * sends; in shadow it ends with a card for Boris. It never answers over our side's message (FR-CONV-6).
 */
async function runTurn(conversationId: string, anchor: string): Promise<void> {
  const turnId = turnWorkflowId(conversationId, anchor)
  const startedAt = await DBOS.runStep(() => startRow(turnId, conversationId, anchor), {
    name: 'start',
    ...DB_STEP,
  })
  let outcome: Outcome = 'failed'
  let covered: string[] = []
  let wakes = 0
  let unreadable = 0
  let holds = 0
  for (let round = 1; ; round++) {
    let heard: Heard
    for (;;) {
      heard = await DBOS.runStep(() => hear(turnId, conversationId, anchor, startedAt), {
        name: `hear-${wakes}`,
        ...DB_STEP,
      })
      wakes++
      if (heard.gate === 'unreadable' && unreadable++ < UNREADABLE_TRIES) {
        await DBOS.sleep(60_000)
        continue
      }
      if (heard.gate !== 'go' || heard.quietLeftS <= 0 || wakes >= MAX_WAKES) break
      await DBOS.recv<string>('poke', { timeoutSeconds: heard.quietLeftS })
    }
    if (heard.gate === 'closed' || heard.gate === 'take') {
      await DBOS.runStep(() => d().forward(turnId), { name: `forward-${round}`, ...DB_STEP })
      outcome = heard.gate === 'take' ? 'forwarded' : 'closed'
      break
    }
    if (heard.gate === 'answered' || heard.gate === 'unclear') {
      outcome = heard.gate
      break
    }
    if (heard.gate === 'unreadable') {
      outcome = 'failed'
      break
    }
    const plan = await DBOS.runStep(() => planStep(turnId, conversationId), {
      name: `plan-${round}`,
    })
    covered = plan.covered
    if (plan.action === 'hold' && plan.holdUntil && holds++ < MAX_HOLDS) {
      await DBOS.sleep(Math.max(0, new Date(plan.holdUntil).getTime() - Date.now()))
      continue
    }
    if (plan.action === 'send' && plan.text) {
      const pause = await DBOS.runStep(
        async () =>
          (d().pauseMs ?? ((n: number) => humanPauseMs(n, Math.random())))(plan.text?.length ?? 0),
        { name: `pause-${round}` },
      )
      await DBOS.sleep(pause)
      const seen = await DBOS.runStep(() => reread(conversationId, anchor, covered), {
        name: `reread-${round}`,
        ...DB_STEP,
      })
      if (seen === 'answered') {
        outcome = 'answered'
        break
      }
      if (seen === 'more' && round < MAX_ROUNDS) continue
      if (seen === 'same') {
        const sent = await DBOS.runStep(() => d().send(turnId, round), { name: `send-${round}` })
        if (sent === 'confirmed') {
          outcome = 'sent'
          break
        }
        if (sent === 'changed' && round < MAX_ROUNDS) continue
        outcome = 'failed'
        await DBOS.runStep(() => d().card(turnId), { name: `card-${round}`, ...DB_STEP })
        break
      }
    }
    if (plan.action === 'nothing') {
      outcome = 'no_reply'
      break
    }
    await DBOS.runStep(() => d().card(turnId), { name: `card-${round}`, ...DB_STEP })
    outcome =
      plan.action === 'call_boris'
        ? 'called_boris'
        : plan.action === 'forward'
          ? 'forwarded'
          : 'drafted'
    break
  }
  const next = await DBOS.runStep(() => handoff(turnId, conversationId, anchor, outcome, covered), {
    name: 'handoff',
    ...DB_STEP,
  })
  if (next)
    await DBOS.startWorkflow(convTurnWorkflow, {
      workflowID: turnWorkflowId(conversationId, next),
    })(conversationId, next)
}

const convTurnWorkflow = DBOS.registerWorkflow(runTurn, { name: 'convTurn' })

/** The anchor of the client turn not yet covered: its first message after our side's last and the handled mark. */
async function pendingAnchor(conv: ConversationRow): Promise<string | null> {
  return turnMessageIds(await storedMessages(d().db, conv.id), conv.handledThrough)[0] ?? null
}

/** The client wrote: the turn of that client turn starts, or the running one wakes (a repeat start is a no-op). */
export async function startTurnFor(conv: ConversationRow): Promise<void> {
  const anchor = await pendingAnchor(conv)
  if (!anchor) return
  const workflowID = turnWorkflowId(conv.id, anchor)
  await DBOS.startWorkflow(convTurnWorkflow, { workflowID })(conv.id, anchor)
  await poke(workflowID)
}

/** Typing or a new message wakes a waiting turn early (FR-CONV-7). */
export async function pokeTurn(conv: ConversationRow): Promise<void> {
  const anchor = await pendingAnchor(conv)
  if (anchor) await poke(turnWorkflowId(conv.id, anchor))
}

async function poke(workflowID: string): Promise<void> {
  try {
    await DBOS.send(workflowID, 'poke', 'poke')
  } catch (e) {
    if ((e as Error).name !== 'DBOSNonExistentWorkflowError') throw e
  }
}
