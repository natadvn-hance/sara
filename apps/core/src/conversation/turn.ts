import { DBOS } from '@dbos-inc/dbos-sdk'
import { type CaseChoice, isTestOrder, newEventId, type Topic } from '@sara/shared'
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { account, convTurn, mindGap } from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import { appendEvent } from '../journal/journal'
import { workHoursSource } from '../leads/callSlots'
import type { ProfiClient } from '../profi/client'
import { getSetting } from '../settings/store'
import { buildDossier, clientNames, turnMessageIds, untilOurs } from './dossier'
import { planTurn } from './engine'
import { readSiteOfTurn } from './siteTurn'
import { applyOwnerRule, getConversation, updateConversation } from './store'
import { storedMessages, syncChat } from './sync'
import { humanPauseMs, quietLeftSeconds } from './timing'
import type {
  CaseHit,
  ConversationRow,
  Decision,
  MindSearch,
  PolicySettings,
  StoredMessage,
} from './types'

export type TurnDeps = {
  db: Db
  profi: ProfiClient
  gateway: Gateway
  mind: MindSearch
  /** The card of a decided turn to Boris: the shadow draft, a draft, a call (part C4). */
  card(turnId: string): Promise<void>
  /** What is new in the chat the turn reads, told to Boris at once (the client's words, shown by whoever reads first). */
  show?(conv: ConversationRow, added: StoredMessage[]): Promise<void>
  /** The same news for the reader of a call booked in the chat. */
  news?(conv: ConversationRow, added: StoredMessage[]): Promise<void>
  /** The client's words to Boris: a client he took, a closed conversation. */
  forward(turnId: string): Promise<void>
  /**
   * A reply to the client after the switch (part C6); 'changed' when the chat moved on. `expectLast` is the last
   * message of the chat the turn saw when it reread it: the service refuses when the chat has moved on from it.
   */
  send(
    turnId: string,
    round: number,
    expectLast: string | null,
  ): Promise<'confirmed' | 'changed' | 'uncertain' | 'failed'>
  /** The human pause; tests shorten it. */
  pauseMs?(textLength: number): number
  /** In shadow, when a turn is over: the real reply our side gave meanwhile is compared with its draft (design 5.12). */
  compare?(turnId: string): Promise<void>
  /** Retries of the card and forward steps; tests shorten them. */
  stepRetry?: { maxAttempts: number; intervalSeconds: number; backoffRate?: number }
  /** After the switch a card Telegram would not take is tried again every 10 minutes, 6 times; tests shorten it. */
  cardRetry?: { tries: number; everyMs: number }
  /** How often and how long an unreadable chat is retried; tests shorten it. */
  unreadableRetry?: { tries: number; everyMs: number }
  /** Every finished turn's fate, for whoever follows turns (M6 meetings); its failure never stops the turn. */
  onOutcome?(o: {
    turnId: string
    conversationId: string
    outcome: string
    at: string
  }): Promise<void>
}

let deps: TurnDeps | null = null
const d = (): TurnDeps => {
  if (!deps) throw new Error('turns are not configured')
  return deps
}

export function setTurnDeps(x: TurnDeps): void {
  deps = x
}

/**
 * `conv-turn:<conversation>:<anchor>`; a turn whose card never reached Boris leaves its client turn unanswered, and the
 * client's next message starts the next attempt at the same anchor under `#<n>` (a finished process is never rerun).
 */
export const turnWorkflowId = (conversationId: string, anchor: string, attempt = 0) =>
  attempt > 0
    ? `conv-turn:${conversationId}:${anchor}#${attempt}`
    : `conv-turn:${conversationId}:${anchor}`

/** A turn plans again at most this many times when the client writes before the reply goes (FR-CONV-6). */
const MAX_ROUNDS = 3
/** After the switch a card Telegram would not take is tried again every 10 minutes, 6 times (as the reminders' cards). */
const CARD_TRIES = 6
const CARD_RETRY_MS = 10 * 60_000
/** Night holds before a turn gives up and drafts. */
const MAX_HOLDS = 2
/** Wake-ups while waiting for the client to finish; the wait itself is capped by conv.max_wait_s. */
const MAX_WAKES = 200
/** An unreadable chat is retried every minute for half an hour. */
const UNREADABLE_TRIES = 30
const DB_STEP = { retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2 }
/** The steps that talk to Telegram or the service: the same retries, and a failure that ends the turn as failed. */
const notifyStep = () => ({ ...DB_STEP, ...d().stepRetry })

/**
 * The reasons of a draft with no text that come from the plumbing, not from a decision: the chat could not be read (the
 * node is down or restarting). Such a turn did not answer the client; the words stay open and a later attempt may take
 * them (Boris, 01.11: a node that restarts under a turn must not cost the client his draft). A planning that threw is
 * not among them: it covers what it saw, as it always did, so the conversation moves on.
 */
export const INFRA_REASONS = ['не могу прочитать чат'] as const

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
  await d()
    .db.insert(convTurn)
    .values({
      id: turnId,
      conversationId,
      anchorMessageId: anchor,
      state: 'waiting',
      timings: { started: now },
    })
    .onConflictDoNothing()
  const [row] = await d()
    .db.select({ timings: convTurn.timings })
    .from(convTurn)
    .where(eq(convTurn.id, turnId))
  return (row?.timings as { started?: string })?.started ?? now
}

/** Step «started»: the client has finished writing; journaled once, after the wait (FR-CONV-7). */
async function markStarted(turnId: string, conversationId: string, anchor: string): Promise<void> {
  const conv = await getConversation(d().db, conversationId)
  if (!conv) return
  await stamp(turnId, 'quiet')
  await journal('conv.turn_started', conv, turnId, { anchor })
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
  const after = sinceAnchor(r.messages, anchor)
  // A message whose side the node could not tell stops the turn, also one that an earlier reading stored.
  if (after.some((m) => m.side === 'unknown')) return { gate: 'unclear', quietLeftS: 0 }
  // After the switch our side's message ends the turn. In shadow it is old Sara's or Boris's answer, which the
  // turn's draft is compared with: the turn goes on and the comparison closes it (design 5.9).
  if (!v1Writes && after.some((m) => m.side === 'specialist'))
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

/** The chat from the turn's first message on. */
const sinceAnchor = (messages: StoredMessage[], anchor: string) => {
  const at = messages.findIndex((m) => m.platformMessageId === anchor)
  return at >= 0 ? messages.slice(at) : []
}

/** A test chat (docs/ops/test-leads.md) is held by neither the pause for real clients nor the live account's state. */
async function policySettings(db: Db, accountId: string, chatId: string): Promise<PolicySettings> {
  const [a] = await db.select().from(account).where(eq(account.id, accountId))
  const test = isTestOrder(chatId)
  return {
    v1Writes: await getSetting(db, 'conv.v1_writes'),
    autopilot: await getSetting(db, 'conv.autopilot'),
    outboundMessages: test || (await getSetting(db, 'outbound.messages')),
    accountPaused:
      !test && (a ? a.paused || a.loginState === 'dead' || a.loginState === 'banned' : false),
    night: await getSetting(db, 'conv.night'),
    autonomy: (await getSetting(db, 'conv.autonomy')) as Record<Topic, 'self' | 'draft' | 'call'>,
    blockedLinks: await getSetting(db, 'links.blocked'),
  }
}

/**
 * The case of a reply for the trace: its moment, id, why and title. `told` is the case the plan returned, one the final
 * reply was offered and no check refused; an id the checks rejected, or one from an earlier attempt, is not traced.
 */
function caseTrace(choice: CaseChoice | undefined, told: CaseHit | undefined) {
  return told && choice
    ? { moment: choice.moment, case_id: told.id, why: choice.why, title: told.title }
    : null
}

/** Steps 2-6 in one DBOS step: the model call is not repeated by a replay. Every failure becomes a draft. */
async function planStep(turnId: string, conversationId: string, anchor: string): Promise<Planned> {
  const { db, gateway, mind, profi } = d()
  const now = new Date()
  const conv = await getConversation(db, conversationId)
  if (!conv) return { action: 'nothing', holdUntil: null, text: null, covered: [] }
  // Even a turn that fails to plan covers the client turn it saw, or the conversation would never get another turn.
  const stored = untilOurs(await storedMessages(db, conversationId), anchor)
  const seen = turnMessageIds(stored, conv.handledThrough)
  try {
    // A site the client names in these words is read first (Boris, 30.10.2026), so the reply can lean on it.
    await readSiteOfTurn(
      { db, gateway },
      conv,
      stored
        .filter((m) => m.side === 'client' && seen.includes(m.platformMessageId))
        .map((m) => m.text),
    )
    const settings = await policySettings(db, conv.accountId, conv.chatId)
    const dossier = await buildDossier(db, conversationId, now, {
      night: settings.night,
      profi,
      anchor,
      turnId,
    })
    await stamp(turnId, 'recalled', { messageIds: dossier.turnMessageIds })
    const plan = await planTurn(
      { gateway, mind, slots: workHoursSource(db) },
      {
        dossier,
        names: await clientNames(db, conv, dossier),
        settings,
        now,
        leadId: conv.orderId,
      },
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
        cases: plan.recall.cases.map((h) => h.id),
      },
      understanding: out
        ? {
            heard: out.heard,
            question_type: out.question_type,
            topic: out.topic,
            tone: out.tone,
            why: out.why,
            // What Sara would have done herself: the card of a turn that calls Boris tells it also in shadow.
            would: plan.decision.would,
            // The case the reply tells (one it was offered that no check refused), with why and its title for the card.
            case: caseTrace(out.case, plan.case),
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
      messageIds: seen,
    })
    return { action: 'draft', holdUntil: null, text: null, covered: seen }
  }
}

/** The chat stayed unreadable: the turn is a draft with the reason, so the card tells Boris. Returns what it covers. */
async function unreadableStep(
  turnId: string,
  conversationId: string,
  anchor: string,
): Promise<string[]> {
  const { db } = d()
  const conv = await getConversation(db, conversationId)
  const seen = conv
    ? turnMessageIds(
        untilOurs(await storedMessages(db, conversationId), anchor),
        conv.handledThrough,
      )
    : []
  await stamp(turnId, 'decided', {
    decision: 'draft',
    decisionReason: 'не могу прочитать чат',
    state: 'decided',
    messageIds: seen,
  })
  return seen
}

/**
 * A step that talks to Telegram or the service: its failure after the retries ends the turn as failed and the
 * workflow goes on to the handoff, so the conversation is never left without a turn (a thrown step error replays
 * the same way). The journal gets the step name and the error class, never the text.
 */
async function tried<T>(
  turnId: string,
  name: string,
  run: () => Promise<T>,
  retry: Record<string, unknown> = {},
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await DBOS.runStep(run, { name, ...retry }) }
  } catch (e) {
    console.error(`turn: step ${name} failed`, e instanceof Error ? e.message : e)
    const reason = `${name}: ${e instanceof Error ? e.name : 'error'}`
    await DBOS.runStep(() => journalStepFailed(turnId, reason), {
      name: `${name}-failed`,
      ...DB_STEP,
    })
    return { ok: false }
  }
}

async function journalStepFailed(turnId: string, reason: string): Promise<void> {
  try {
    const [t] = await d().db.select().from(convTurn).where(eq(convTurn.id, turnId))
    const conv = t ? await getConversation(d().db, t.conversationId) : null
    if (!conv) return
    await appendEvent(d().db, {
      type: 'notify.failed',
      v: 1,
      entity: { kind: 'conv_turn', id: turnId },
      account_id: conv.accountId,
      actor: 'sara',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: conv.id,
      reason,
      payload: { channel: 'telegram', what: 'conv_turn' },
    })
  } catch (e) {
    // A lost diagnostic never stops the handoff.
    console.error('turn: step failure not journaled', e instanceof Error ? e.message : e)
  }
}

type Seen = 'same' | 'more' | 'answered' | 'unclear' | 'closed' | 'take' | 'held'

/**
 * Step 7 before sending: what happened since the plan, during the human pause too. The client wrote more, our side
 * answered, a message of an unknown side came, Boris pressed «Закрыть» or «Беру сам», or the account or the «Пишет
 * клиентам» switch was paused (then the reply is a draft with that reason).
 */
async function reread(
  turnId: string,
  conversationId: string,
  anchor: string,
  covered: string[],
): Promise<{ seen: Seen; lastId: string | null }> {
  const { db } = d()
  let conv = await getConversation(db, conversationId)
  if (!conv) return { seen: 'answered', lastId: null }
  const v1Writes = await getSetting(db, 'conv.v1_writes')
  const r = await syncChat(d(), conv, new Date(), { v1Writes })
  conv = await applyOwnerRule(db, conv, r.added, { v1Writes })
  const lastId = r.messages.at(-1)?.platformMessageId ?? null
  const stop = (seen: Seen) => ({ seen, lastId })
  if (conv.closedAt) return stop('closed')
  if (conv.owner === 'boris' && conv.ownerReason === 'take') return stop('take')
  const after = sinceAnchor(r.messages, anchor)
  if (after.some((m) => m.side === 'unknown')) return stop('unclear')
  if (!v1Writes && after.some((m) => m.side === 'specialist')) return stop('answered')
  const known = new Set(covered)
  if (after.some((m) => m.side === 'client' && !known.has(m.platformMessageId))) return stop('more')
  const settings = await policySettings(db, conv.accountId, conv.chatId)
  const why = settings.v1Writes
    ? 'режим тени'
    : settings.accountPaused
      ? 'аккаунт на паузе'
      : !settings.outboundMessages
        ? 'пауза «Пишет клиентам»'
        : !settings.autopilot
          ? 'отправлю по твоему нажатию'
          : null
  if (why) {
    await stamp(turnId, 'reread', { decision: 'draft', decisionReason: why })
    return stop('held')
  }
  return stop('same')
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
  card_lost: 'conv.turn_failed',
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
  // A turn that covered nothing (Boris's client, an unclear author, a failure) still covers what it saw; only a
  // turn that our side's message cancelled does not, that message already ends the client turn.
  const [row] = await db
    .select({ reason: convTurn.decisionReason, text: convTurn.text })
    .from(convTurn)
    .where(eq(convTurn.id, turnId))
  const plumbing = !row?.text && (INFRA_REASONS as readonly string[]).includes(row?.reason ?? '')
  const through =
    // After the switch the card is the client's only way to an answer: when it did not reach Boris the words stay open;
    // so they do when the turn only met a chat it could not read or a planning that threw.
    outcome === 'card_lost' || plumbing
      ? undefined
      : (covered.at(-1) ??
        (outcome !== 'answered'
          ? untilOurs(messages, anchor).findLast((m) => m.side === 'client')?.platformMessageId
          : undefined))
  // The mark only moves forward: «Вернуть» or another turn may have moved it further while this one ran.
  const at = (id: string | null | undefined) =>
    id ? messages.findIndex((m) => m.platformMessageId === id) : -1
  if (through && at(through) > at(conv.handledThrough))
    conv = await updateConversation(db, conversationId, { handledThrough: through })
  await stamp(turnId, 'finished', {
    state: 'finished',
    outcome,
    finishedAt: new Date().toISOString(),
  })
  await journal(OUTCOME_EVENT[outcome], conv, turnId, { outcome })
  const next = turnMessageIds(await storedMessages(db, conversationId), conv.handledThrough)[0]
  return next && next !== anchor ? next : null
}

/** The card of a turn could not be told to Boris in all the tries: the journal says the client has no answer. */
async function journalCardLost(turnId: string): Promise<void> {
  const [t] = await d().db.select().from(convTurn).where(eq(convTurn.id, turnId))
  const conv = t ? await getConversation(d().db, t.conversationId) : null
  if (!conv) return
  await appendEvent(d().db, {
    type: 'notify.failed',
    v: 1,
    entity: { kind: 'conv_turn', id: turnId },
    account_id: conv.accountId,
    actor: 'sara',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: conv.id,
    reason: 'карточка не дошла: клиент без ответа',
    payload: { channel: 'telegram', what: 'conv_card_lost' },
  })
}

/** Whether the switch is made (old Sara no longer writes): then the card is the client's only way to an answer. */
async function afterSwitch(): Promise<boolean> {
  return !(await getSetting(d().db, 'conv.v1_writes'))
}

/**
 * The card of a decided turn to Boris. In shadow a card that cannot be sent ends the turn as failed (the cards only
 * teach). After the switch it is the client's only way to an answer, so it is tried again every 10 minutes, 6 times;
 * if it still does not go, the turn ends as `card_lost`: the client's words stay unhandled, the journal says so, and
 * his next message starts the next attempt.
 */
async function sendCard(turnId: string, name: string): Promise<'ok' | 'failed' | 'lost'> {
  const first = await tried(turnId, name, () => d().card(turnId), notifyStep())
  if (first.ok) return 'ok'
  if (!(await DBOS.runStep(() => afterSwitch(), { name: `${name}-live`, ...DB_STEP })))
    return 'failed'
  for (let a = 1; a < (d().cardRetry?.tries ?? CARD_TRIES); a++) {
    await DBOS.sleep(d().cardRetry?.everyMs ?? CARD_RETRY_MS)
    const again = await tried(turnId, `${name}-r${a}`, () => d().card(turnId), notifyStep())
    if (again.ok) return 'ok'
  }
  await DBOS.runStep(() => journalCardLost(turnId), { name: `${name}-lost`, ...DB_STEP })
  return 'lost'
}

/**
 * One turn of the conversation: Sara's answer to one client turn (FR-CONV-3, M4 design 5.5, 5.7). It waits while the
 * client writes, plans in one step, holds at night, and after the switch pauses like a human, rereads the chat and
 * sends; in shadow it ends with a card for Boris. It never answers over our side's message (FR-CONV-6).
 */
async function runTurn(conversationId: string, anchor: string, attempt = 0): Promise<void> {
  const turnId = turnWorkflowId(conversationId, anchor, attempt)
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
      if (
        heard.gate === 'unreadable' &&
        unreadable++ < (d().unreadableRetry?.tries ?? UNREADABLE_TRIES)
      ) {
        await DBOS.sleep(d().unreadableRetry?.everyMs ?? 60_000)
        continue
      }
      if (heard.gate !== 'go' || heard.quietLeftS <= 0 || wakes >= MAX_WAKES) break
      await DBOS.recv<string>('poke', { timeoutSeconds: heard.quietLeftS })
    }
    if (heard.gate === 'closed' || heard.gate === 'take') {
      const fwd = await tried(turnId, `forward-${round}`, () => d().forward(turnId), notifyStep())
      outcome = !fwd.ok ? 'failed' : heard.gate === 'take' ? 'forwarded' : 'closed'
      break
    }
    if (heard.gate === 'answered' || heard.gate === 'unclear') {
      outcome = heard.gate
      break
    }
    if (heard.gate === 'unreadable') {
      // Thirty minutes without a chat: Boris is told, the turn is over.
      covered = await DBOS.runStep(() => unreadableStep(turnId, conversationId, anchor), {
        name: 'unreadable',
        ...DB_STEP,
      })
      outcome = (await sendCard(turnId, 'card-unreadable')) === 'lost' ? 'card_lost' : 'failed'
      break
    }
    // The turn starts for real when the client has finished writing: the moment others measure from (M6).
    if (round === 1)
      await DBOS.runStep(() => markStarted(turnId, conversationId, anchor), {
        name: 'started',
        ...DB_STEP,
      })
    const plan = await DBOS.runStep(() => planStep(turnId, conversationId, anchor), {
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
      const read = await tried(
        turnId,
        `reread-${round}`,
        () => reread(turnId, conversationId, anchor, covered),
        notifyStep(),
      )
      if (!read.ok) {
        // The chat cannot be read to check: nothing is sent, Boris gets the draft.
        outcome = (await sendCard(turnId, `card-${round}`)) === 'lost' ? 'card_lost' : 'failed'
        break
      }
      const seen = read.value.seen
      if (seen === 'answered' || seen === 'unclear') {
        outcome = seen
        break
      }
      if (seen === 'closed' || seen === 'take') {
        const fwd = await tried(
          turnId,
          `reread-forward-${round}`,
          () => d().forward(turnId),
          notifyStep(),
        )
        outcome = !fwd.ok ? 'failed' : seen === 'take' ? 'forwarded' : 'closed'
        break
      }
      if (seen === 'held') {
        const held = await sendCard(turnId, `reread-card-${round}`)
        outcome = held === 'ok' ? 'drafted' : held === 'lost' ? 'card_lost' : 'failed'
        break
      }
      if (seen === 'more' && round < MAX_ROUNDS) continue
      if (seen === 'same') {
        const sent = await tried(turnId, `send-${round}`, () =>
          d().send(turnId, round, read.value.lastId),
        )
        if (sent.ok && sent.value === 'confirmed') {
          outcome = 'sent'
          break
        }
        if (sent.ok && sent.value === 'changed' && round < MAX_ROUNDS) continue
        outcome = (await sendCard(turnId, `card-${round}`)) === 'lost' ? 'card_lost' : 'failed'
        break
      }
    }
    if (plan.action === 'nothing') {
      outcome = 'no_reply'
      break
    }
    const card = await sendCard(turnId, `card-${round}`)
    outcome =
      card === 'lost'
        ? 'card_lost'
        : card === 'failed'
          ? 'failed'
          : plan.action === 'call_boris'
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
  await DBOS.runStep(
    () =>
      (
        d().onOutcome?.({ turnId, conversationId, outcome, at: new Date().toISOString() }) ??
        Promise.resolve()
      ).catch((e) => console.error('turn outcome hook failed', e instanceof Error ? e.message : e)),
    { name: 'outcome' },
  )
  // In shadow our side may have answered while the turn ran: its real reply is put beside the draft now that the
  // turn is over (a message that comes later is compared by its own event). A failure here changes no outcome.
  if (outcome === 'drafted' || outcome === 'called_boris')
    await tried(turnId, 'compare', async () => d().compare?.(turnId), notifyStep())
  if (next)
    await DBOS.startWorkflow(convTurnWorkflow, {
      workflowID: turnWorkflowId(conversationId, next),
    })(conversationId, next)
}

const convTurnWorkflow = DBOS.registerWorkflow(runTurn, { name: 'convTurn' })

/** The anchor of the client turn not yet covered: its first message after our side's last and the handled mark. */
async function pendingAnchor(conv: ConversationRow): Promise<string | null> {
  // The caller's row may be older than a handoff that has just marked its work: the mark is read fresh.
  const fresh = (await getConversation(d().db, conv.id)) ?? conv
  return turnMessageIds(await storedMessages(d().db, conv.id), fresh.handledThrough)[0] ?? null
}

/**
 * Which attempt of the client turn at `anchor` is the current one: every earlier turn of it whose card never reached
 * Boris (`card_lost`), or that met only a chat it could not read, leaves it unanswered; the client's next message or a
 * later catch-up starts the next attempt.
 */
async function attemptOf(conversationId: string, anchor: string): Promise<number> {
  const rows = await d()
    .db.select({ id: convTurn.id })
    .from(convTurn)
    .where(
      and(
        eq(convTurn.conversationId, conversationId),
        eq(convTurn.kind, 'reply'),
        eq(convTurn.anchorMessageId, anchor),
        or(
          eq(convTurn.outcome, 'card_lost'),
          and(
            isNull(convTurn.text),
            isNotNull(convTurn.finishedAt),
            inArray(convTurn.decisionReason, [...INFRA_REASONS]),
          ),
        ),
      ),
    )
  return rows.length
}

/** The client wrote: the turn of that client turn starts, or the running one wakes (a repeat start is a no-op). */
export async function startTurnFor(conv: ConversationRow): Promise<void> {
  const anchor = await pendingAnchor(conv)
  if (!anchor) return
  const attempt = await attemptOf(conv.id, anchor)
  const workflowID = turnWorkflowId(conv.id, anchor, attempt)
  await DBOS.startWorkflow(convTurnWorkflow, { workflowID })(conv.id, anchor, attempt)
  await poke(workflowID)
}

/** Typing or a new message wakes a waiting turn early (FR-CONV-7). */
export async function pokeTurn(conv: ConversationRow): Promise<void> {
  const anchor = await pendingAnchor(conv)
  if (anchor) await poke(turnWorkflowId(conv.id, anchor, await attemptOf(conv.id, anchor)))
}

/** DBOS's code of a send to a workflow that does not exist (DBOSNonExistentWorkflowError). */
const NON_EXISTENT_WORKFLOW = 16

async function poke(workflowID: string): Promise<void> {
  try {
    await DBOS.send(workflowID, 'poke', 'poke')
  } catch (e) {
    // No turn waits on this client turn: nothing to wake. DBOS marks the error by its code, its name is plain «Error».
    if ((e as { dbosErrorCode?: number }).dbosErrorCode !== NON_EXISTENT_WORKFLOW) throw e
  }
}
