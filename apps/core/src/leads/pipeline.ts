import { DBOS } from '@dbos-inc/dbos-sdk'
import { type EventEnvelope, newEventId, ProfiOrder, type TaskAction } from '@sara/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { event, lead, leadScore, task } from '../db/schema'
import { activeRules } from '../direction/store'
import type { Gateway } from '../gateway/gateway'
import { appendEvent } from '../journal/journal'
import { recordLabel } from '../learning/labels'
import { onProposalPress } from '../learning/proposals'
import {
  askForDraft,
  askWhy,
  closeDraftRequests,
  type DraftAnswer,
  markAnswered,
} from '../learning/questions'
import type { LeadCard } from '../notify/cards'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import type { ProfiClient } from '../profi/client'
import { getSetting } from '../settings/store'
import { deliverDecision, startDecisionWait } from '../workflows/decisionWait'
import { CARD_FLOW_TEXTS, cardsToday, isStale, lockCards, quietNow } from './cardFlow'
import {
  BID_TEXT_MAX,
  bodyOf,
  type Draft,
  type DraftMiss,
  type DraftSource,
  editOf,
  writeDraft,
} from './draft'
import { readWallet, refuseSpend } from './money'
import { recordBid, startOutboxDelivery } from './outbox'
import { type Scored, scoreOrder } from './scorer'
import { sortOrder } from './sorter'

export type LeadPipelineDeps = {
  db: Db
  gateway: Gateway
  notifier: Notifier
  /** The wallet for the money check before a bid (FR-LEAD-9). */
  profi: Pick<ProfiClient, 'sessionHealth'>
  remindAfterMs: () => Promise<number>
  /** Card sending is retried, for example while the bot is starting (default 5 attempts from 2 s). */
  notifyRetry?: { maxAttempts: number; intervalSeconds: number }
}

export type LeadPipeline = {
  onOrderSeen(e: EventEnvelope): Promise<void>
  onPress(p: { taskId: string; action: TaskAction }): Promise<string>
  onReminder(taskId: string): Promise<void>
  resendCard(taskId: string): Promise<void>
  /** Boris's answer to the request after «Изменить»: the new bid text; the reply goes back to him. */
  onDraftText(a: DraftAnswer): Promise<string>
}

/** Database steps may hit a passing database error; they are safe to repeat. */
const DB_STEP = { retriesAllowed: true, maxAttempts: 3, intervalSeconds: 1 }

let deps: LeadPipelineDeps | null = null
function d(): LeadPipelineDeps {
  if (!deps) throw new Error('lead pipeline is not configured')
  return deps
}

const ev = (
  type:
    | 'lead.found'
    | 'lead.sorted'
    | 'lead.scored'
    | 'lead.skipped'
    | 'lead.stale'
    | 'lead.held'
    | 'lead.drafted'
    | 'draft.edited'
    | 'task.created'
    | 'task.resolved'
    | 'task.reminded'
    | 'card.sent',
  entity: { kind: string; id: string },
  correlationId: string,
  actor: 'sara' | 'boris',
  payload: Record<string, unknown> = {},
  causationId: string | null = null,
) => ({
  type,
  v: 1,
  entity,
  account_id: 'hance-marketing',
  actor,
  occurred_at: new Date().toISOString(),
  causation_id: causationId,
  correlation_id: correlationId,
  reason: null,
  payload,
})

type Sorted = { verdict: 'fit' | 'maybe' | 'reject' | null; reason: string | null }
type LeadRow = typeof lead.$inferSelect

const sourceOf = (l: LeadRow): DraftSource => ({
  title: l.title,
  category: l.category,
  city: l.city,
  budget_text: l.budgetText,
  text: l.text,
  client_name: l.clientName,
})

/** The Analyst's draft, or why there is none; any failure is «no answer», the card comes anyway. */
async function draftFor(
  o: DraftSource,
  opts: { correlationId: string; causationId?: string },
): Promise<Draft | DraftMiss> {
  try {
    return await writeDraft(d().gateway, o, opts)
  } catch (err) {
    console.error('draft failed', err instanceof Error ? err.message.slice(0, 200) : err)
    return { text: null, reason: 'no_answer', attempts: 1 }
  }
}

/** The draft goes on the lead (one there already, Boris's edit, is kept) and its outcome into the journal. */
function storeDraft(
  l: { id: string; correlationId: string },
  dr: Draft | DraftMiss,
): Promise<void> {
  return d().db.transaction(async (tx) => {
    if (dr.text !== null) {
      await tx
        .update(lead)
        .set({ draftText: dr.text, draftPriceRub: dr.priceRub })
        .where(and(eq(lead.id, l.id), isNull(lead.draftText)))
    }
    await appendEvent(
      tx,
      ev('lead.drafted', { kind: 'lead', id: l.id }, l.correlationId, 'sara', draftedPayload(dr)),
    )
  })
}

/** The journal keeps how the draft went, never its text (ADR-016). */
const draftedPayload = (dr: Draft | DraftMiss) =>
  dr.text !== null
    ? {
        drafted: true,
        chars: dr.text.length,
        price_rub: dr.priceRub,
        attempts: dr.attempts,
        reason: null,
      }
    : { drafted: false, chars: null, price_rub: null, attempts: dr.attempts, reason: dr.reason }

/** One order, one durable run (workflow id lead:<order>): record, sort, card, wait for Boris. */
async function processOrder(e: EventEnvelope): Promise<void> {
  const order = ProfiOrder.parse(e.payload)
  const correlationId = e.correlation_id
  // Runs recorded before M2 return a boolean; 'stale' is a new order too old to offer (FR-LEAD-10).
  const isNew = await DBOS.runStep(
    (): Promise<boolean | 'stale'> =>
      d().db.transaction(async (tx) => {
        // Decided before any model call: a stale order costs no sorting or scoring.
        const stale = isStale(order.published_at, new Date())
        const rows = await tx
          .insert(lead)
          .values({
            id: order.order_id,
            accountId: e.account_id ?? 'hance-marketing',
            title: order.title,
            category: order.category,
            city: order.city,
            text: order.text,
            clientName: order.client_name,
            budgetText: order.budget_text,
            bidPriceRub: order.bid_price_rub,
            seenAt: order.seen_at,
            correlationId,
            ...(stale && { status: 'stale' }),
          })
          .onConflictDoNothing({ target: lead.id })
          .returning({ id: lead.id })
        if (rows.length === 0) return false
        await appendEvent(
          tx,
          ev('lead.found', { kind: 'lead', id: order.order_id }, correlationId, 'sara', {}, e.id),
        )
        if (!stale) return true
        await appendEvent(
          tx,
          ev('lead.stale', { kind: 'lead', id: order.order_id }, correlationId, 'sara', {
            published_at: order.published_at,
          }),
        )
        return 'stale'
      }),
    { name: 'record', ...DB_STEP },
  )
  if (isNew !== true) return

  const sorted = await DBOS.runStep(
    async (): Promise<Sorted> => {
      const r = await sortOrder(d().gateway, order, { correlationId, causationId: e.id })
      return r.ok
        ? { verdict: r.output.verdict, reason: r.output.reason }
        : { verdict: null, reason: null }
    },
    { name: 'sort' },
  )

  if (sorted.verdict === 'reject') {
    await DBOS.runStep(
      () =>
        d().db.transaction(async (tx) => {
          await tx.update(lead).set({ status: 'sorted_out' }).where(eq(lead.id, order.order_id))
          await appendEvent(
            tx,
            ev('lead.sorted', { kind: 'lead', id: order.order_id }, correlationId, 'sara', sorted),
          )
        }),
      { name: 'sortedOut', ...DB_STEP },
    )
    return
  }

  const accountId = e.account_id ?? 'hance-marketing'
  const scored = await DBOS.runStep(
    async (): Promise<(Scored & { version: number }) | null> => {
      // Any failure here (no rules, the model down) brings the card unscored: the order is never lost.
      try {
        const { version, rules } = await activeRules(d().db, accountId)
        const s = await scoreOrder(d().gateway, order, rules, { correlationId, causationId: e.id })
        return s ? { ...s, version } : null
      } catch (err) {
        console.error('scoring failed', err instanceof Error ? err.message.slice(0, 200) : err)
        return null
      }
    },
    { name: 'score' },
  )
  if (scored) {
    await DBOS.runStep(
      () =>
        d().db.transaction(async (tx) => {
          await tx.insert(leadScore).values({
            id: newEventId(),
            leadId: order.order_id,
            version: scored.version,
            score: scored.score,
            decision: scored.decision,
            stopFactor: scored.stopFactor,
            redFlags: scored.redFlags,
            axes: scored.axes,
            reason: scored.reason,
            confidence: scored.confidence,
            model: scored.model,
          })
          if (scored.decision === 'drop') {
            await tx.update(lead).set({ status: 'scored_out' }).where(eq(lead.id, order.order_id))
            // A dropped order never reaches the task step, so its sorter verdict is journaled here.
            if (sorted.verdict) {
              await appendEvent(
                tx,
                ev(
                  'lead.sorted',
                  { kind: 'lead', id: order.order_id },
                  correlationId,
                  'sara',
                  sorted,
                ),
              )
            }
          }
          await appendEvent(
            tx,
            ev('lead.scored', { kind: 'lead', id: order.order_id }, correlationId, 'sara', {
              score: scored.score,
              decision: scored.decision,
              version: scored.version,
              stop_factor: scored.stopFactor,
            }),
          )
        }),
      { name: 'scored', ...DB_STEP },
    )
    // Below the threshold or a stop factor: kept for the daily summary, nothing goes to Boris.
    if (scored.decision === 'drop') return
  }

  // A run recorded before the Analyst existed resumes along its old steps and brings its card without a draft.
  const draft = (await DBOS.patch('analyst-draft'))
    ? await DBOS.runStep(() => draftFor(order, { correlationId, causationId: e.id }), {
        name: 'draft',
      })
    : null
  if (draft) {
    await DBOS.runStep(() => storeDraft({ id: order.order_id, correlationId }, draft), {
      name: 'drafted',
      ...DB_STEP,
    })
  }

  // Runs recorded before M2 return the id; null is an order held over the day's card cap (FR-NOTIF-3).
  const taskId = await DBOS.runStep(
    (): Promise<string | null> =>
      d().db.transaction(async (tx) => {
        const id = newEventId()
        await lockCards(tx)
        const full =
          (await cardsToday(tx, new Date())) >= (await getSetting(tx, 'cards.max_per_day'))
        if (sorted.verdict) {
          await appendEvent(
            tx,
            ev('lead.sorted', { kind: 'lead', id: order.order_id }, correlationId, 'sara', sorted),
          )
        }
        if (full) {
          // No decision task, so no reminder: the order waits for the 19:00 summary.
          await tx.update(lead).set({ status: 'held' }).where(eq(lead.id, order.order_id))
          await appendEvent(
            tx,
            ev('lead.held', { kind: 'lead', id: order.order_id }, correlationId, 'sara'),
          )
          return null
        }
        await tx
          .insert(task)
          .values({ id, kind: 'lead_decision', entityKind: 'lead', entityId: order.order_id })
        await tx.update(lead).set({ status: 'queued' }).where(eq(lead.id, order.order_id))
        await appendEvent(
          tx,
          ev('task.created', { kind: 'task', id }, correlationId, 'sara', {
            lead_id: order.order_id,
          }),
        )
        return id
      }),
    { name: 'task', ...DB_STEP },
  )
  if (taskId === null) return

  // The wait starts before the card goes out, so an instant press always finds it.
  const remindAfter = await DBOS.runStep(() => d().remindAfterMs(), { name: 'remindAfter' })
  await startDecisionWait(taskId, remindAfter)

  const card: LeadCard = {
    taskId,
    title: order.title,
    city: order.city,
    verdict: sorted.verdict,
    reason: sorted.reason,
    bidPriceRub: order.bid_price_rub,
    score: scored ? { value: scored.score, version: scored.version, reason: scored.reason } : null,
    unscored: !scored,
    draft: draft?.text ? { text: draft.text, priceRub: draft.priceRub } : null,
  }
  const retry = d().notifyRetry ?? { maxAttempts: 5, intervalSeconds: 2 }
  try {
    await DBOS.runStep(
      async () => {
        const silent = await quietNow(d().db, new Date())
        const m = await d().notifier.sendLeadCard(card, { silent })
        await cardSent(taskId, correlationId, m.messageId, 'order')
      },
      { name: 'card', retriesAllowed: true, backoffRate: 1, ...retry },
    )
  } catch (err) {
    // The lead and its task stay; the reminder later brings the card back with its buttons.
    const reason = err instanceof Error ? err.message.slice(0, 200) : 'card was not sent'
    await DBOS.runStep(
      () =>
        appendEvent(d().db, {
          ...ev('task.created', { kind: 'task', id: taskId }, correlationId, 'sara'),
          type: 'notify.failed',
          reason,
          payload: { channel: 'telegram', what: 'lead_card' },
        }).then(() => undefined),
      { name: 'cardFailed', ...DB_STEP },
    )
  }
}

const processOrderWorkflow = DBOS.registerWorkflow(processOrder, { name: 'processOrder' })

async function leadOfTask(taskId: string) {
  const [t] = await d().db.select().from(task).where(eq(task.id, taskId))
  if (!t) return null
  const [l] = await d().db.select().from(lead).where(eq(lead.id, t.entityId))
  return l ? { task: t, lead: l } : null
}

/** The lead card for an open task, rebuilt from the lead and its last sorter verdict. */
async function cardOfTask(taskId: string, reminder: boolean): Promise<LeadCard | null> {
  const found = await leadOfTask(taskId)
  if (!found || found.task.state !== 'open') return null
  const [sorted] = await d()
    .db.select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.correlationId, found.lead.correlationId), eq(event.type, 'lead.sorted')))
    .orderBy(desc(event.id))
    .limit(1)
  const s = (sorted?.payload ?? {}) as {
    verdict?: 'fit' | 'maybe' | 'reject' | null
    reason?: string | null
  }
  const [sc] = await d()
    .db.select()
    .from(leadScore)
    .where(and(eq(leadScore.leadId, found.lead.id), eq(leadScore.backtest, false)))
    .orderBy(desc(leadScore.createdAt))
    .limit(1)
  return {
    taskId,
    title: found.lead.title,
    city: found.lead.city,
    verdict: s.verdict === 'fit' || s.verdict === 'maybe' ? s.verdict : null,
    reason: s.reason ?? null,
    bidPriceRub: found.lead.bidPriceRub,
    score: sc ? { value: sc.score, version: sc.version, reason: sc.reason } : null,
    reminder,
    draft: found.lead.draftText
      ? { text: found.lead.draftText, priceRub: found.lead.draftPriceRub }
      : null,
  }
}

/**
 * A card went out: the task keeps the new message (the one Boris sees last) and the journal the moment, which
 * the speed report reads for the order's own card (via 'order').
 */
function cardSent(
  taskId: string,
  correlationId: string,
  messageId: number,
  via: 'order' | 'summary' | 'edit',
): Promise<void> {
  return d().db.transaction(async (tx) => {
    await tx.update(task).set({ telegramMessageId: messageId }).where(eq(task.id, taskId))
    await appendEvent(
      tx,
      ev('card.sent', { kind: 'task', id: taskId }, correlationId, 'sara', { via }),
    )
  })
}

/** The card of an open task, sent now. */
async function sendCard(taskId: string, via: 'summary' | 'edit'): Promise<void> {
  const card = await cardOfTask(taskId, false)
  const found = card ? await leadOfTask(taskId) : null
  if (card && found) {
    const m = await d().notifier.sendLeadCard(card)
    await cardSent(taskId, found.lead.correlationId, m.messageId, via)
  }
}

/** A dropped order Boris wants after all: its draft first (the Scorer's drop wrote none), then its card. */
async function draftThenCard(l: LeadRow, taskId: string): Promise<void> {
  if (!l.draftText)
    await storeDraft(l, await draftFor(sourceOf(l), { correlationId: l.correlationId }))
  await sendCard(taskId, 'summary')
}

/** «Изменить»: Sara asks for the new text; the card stays as it is until the text comes. */
async function onEdit(taskId: string): Promise<string> {
  const found = await leadOfTask(taskId)
  if (found?.task.kind !== 'lead_decision' || found.task.state !== 'open') return TEXTS.alreadyDone
  await askForDraft(d(), { taskId, title: found.lead.title }, new Date())
  return TEXTS.waitingDraft
}

/**
 * The new bid text: the same greeting and length rules as the Analyst's, then an updated card. The edit is
 * journaled (draft.edited, before and after) without the greeting, so no client name reaches the journal.
 */
async function onDraftText(a: DraftAnswer): Promise<string> {
  const found = await leadOfTask(a.question.entityId)
  if (found?.task.state !== 'open') {
    // Decided meanwhile: the requests are closed so a later message does not land on them.
    await d().db.transaction(async (tx) => {
      await markAnswered(tx, a.question, a)
      await closeDraftRequests(tx, a.question.entityId, a.at)
    })
    return TEXTS.draftLate
  }
  const { lead: l, task: t } = found
  const next = editOf(a.text, l.clientName)
  // Too long: the request stays open, the next text answers it.
  if (next.length > BID_TEXT_MAX) return TEXTS.draftTooLong(next.length)
  const saved = await d().db.transaction(async (tx) => {
    if (!(await markAnswered(tx, a.question, a))) return false
    await closeDraftRequests(tx, t.id, a.at)
    await tx.update(lead).set({ draftText: next }).where(eq(lead.id, l.id))
    await appendEvent(
      tx,
      ev('draft.edited', { kind: 'lead', id: l.id }, l.correlationId, 'boris', {
        before: l.draftText === null ? null : bodyOf(l.draftText),
        after: bodyOf(next),
        voice: a.voice,
      }),
    )
    return true
  })
  if (!saved) return TEXTS.alreadyDone
  await sendCard(t.id, 'edit')
  return TEXTS.draftSaved
}

/**
 * A button of the daily summary brings its order back as a normal card with a decision task, once: «Взял бы»
 * on a dropped order (lead_review, want) or «Показать» on one held over the card cap (lead_held, open).
 */
async function bringCard(
  fromId: string,
  kind: 'lead_review' | 'lead_held',
  action: 'want' | 'open',
): Promise<typeof lead.$inferSelect | null> {
  const [t] = await d().db.select().from(task).where(eq(task.id, fromId))
  if (t?.kind !== kind) return null
  const [l] = await d().db.select().from(lead).where(eq(lead.id, t.entityId))
  if (!l) return null
  const decisionId = newEventId()
  const resolved = await d().db.transaction(async (tx) => {
    const rows = await tx
      .update(task)
      .set({ state: 'resolved', resolution: action, resolvedAt: new Date().toISOString() })
      .where(and(eq(task.id, fromId), eq(task.state, 'open')))
      .returning({ id: task.id })
    if (rows.length === 0) return false
    await appendEvent(
      tx,
      ev('task.resolved', { kind: 'task', id: fromId }, l.correlationId, 'boris', { action }),
    )
    await tx
      .insert(task)
      .values({ id: decisionId, kind: 'lead_decision', entityKind: 'lead', entityId: l.id })
    await tx.update(lead).set({ status: 'queued' }).where(eq(lead.id, l.id))
    await appendEvent(
      tx,
      // Brought from the summary hours after the order: not a lead-to-card time (FR-ANL-3).
      ev('task.created', { kind: 'task', id: decisionId }, l.correlationId, 'sara', {
        lead_id: l.id,
        via: 'summary',
      }),
    )
    return true
  })
  if (!resolved) return null
  await startDecisionWait(decisionId, await d().remindAfterMs())
  if (action === 'open') {
    // A held order got its draft before its task: the card goes at once.
    await sendCard(decisionId, 'summary')
  } else {
    // A dropped order has no draft yet: the press is answered now, the card follows its draft (a reminder brings
    // it back if this fails).
    void draftThenCard(l, decisionId).catch((err) =>
      console.error('want card failed', err instanceof Error ? err.message.slice(0, 200) : err),
    )
  }
  return l
}

/**
 * «Взял бы» from the daily summary: Boris's yes on an order Sara dropped. It is a label and a surprise («почему?»),
 * and the order comes back as a normal card so he can bid on it.
 */
async function onWant(reviewId: string): Promise<string> {
  const l = await bringCard(reviewId, 'lead_review', 'want')
  if (!l) return TEXTS.alreadyDone
  learnFrom({ leadId: l.id, label: 'yes', source: 'summary' }, 'why_want', l.title)
  return TEXTS.wantCard
}

/** «Показать» from the daily summary: an order held over the card cap comes as a card; Boris has not decided yet. */
async function onOpen(heldId: string): Promise<string> {
  const found = await leadOfTask(heldId)
  // FR-LEAD-10 at the press, which may come days after the summary. The lead keeps no publication time; seen_at
  // is never earlier, so this errs toward showing.
  if (
    found?.task.kind === 'lead_held' &&
    found.task.state === 'open' &&
    isStale(found.lead.seenAt, new Date())
  )
    return CARD_FLOW_TEXTS.staleHeld
  return (await bringCard(heldId, 'lead_held', 'open')) ? TEXTS.cardSent : TEXTS.alreadyDone
}

/**
 * The label and the «почему?» after a decision. Not awaited and never thrown: learning must not hold up or
 * break a bid or a card that already happened.
 */
function learnFrom(
  label: Parameters<typeof recordLabel>[1],
  why: 'why_skip' | 'why_want',
  title: string,
): void {
  void (async () => {
    const labeled = await recordLabel(d().db, label)
    if (labeled.surprise)
      await askWhy(d(), { kind: why, entityId: label.leadId, title }, new Date())
  })().catch((e) => console.error('learning skipped', e instanceof Error ? e.message : e))
}

export function createLeadPipeline(dp: LeadPipelineDeps): LeadPipeline {
  deps = dp
  return {
    async onOrderSeen(e) {
      if (e.type !== 'profi.order_seen') return
      const order = ProfiOrder.safeParse(e.payload)
      if (!order.success) return
      await DBOS.startWorkflow(processOrderWorkflow, { workflowID: `lead:${order.data.order_id}` })(
        e,
      )
    },

    async onPress({ taskId, action }) {
      if (action === 'want') return onWant(taskId)
      if (action === 'open') return onOpen(taskId)
      if (action === 'edit') return onEdit(taskId)
      if (action === 'apply' || action === 'drop') return onProposalPress(d(), taskId, action)
      if (action !== 'bid' && action !== 'skip') return TEXTS.alreadyDone
      const found = await leadOfTask(taskId)
      if (!found) return TEXTS.alreadyDone
      const { lead: l } = found
      // Paused or refused for money: nothing is decided, the card stays usable for a press later.
      let wallet: number | null = null
      if (action === 'bid' && found.task.state === 'open') {
        if (!(await getSetting(d().db, 'outbound.bids'))) return TEXTS.bidsPausedPress
        // No text to send yet: the card waits for «Изменить», and the wallet need not be read.
        if (l.draftText === null) return TEXTS.noDraft
        wallet = await readWallet(d().profi, l.accountId)
      }
      const text = l.draftText
      let outboxId: string | null = null
      let refusal: string | null = null
      const resolved = await d()
        .db.transaction(async (tx) => {
          const rows = await tx
            .update(task)
            .set({ state: 'resolved', resolution: action, resolvedAt: new Date().toISOString() })
            .where(and(eq(task.id, taskId), eq(task.state, 'open')))
            .returning({ id: task.id })
          if (rows.length === 0) return false
          if (action === 'bid') {
            refusal = await refuseSpend(tx, {
              feeRub: l.bidPriceRub,
              balanceRub: wallet,
              now: new Date(),
            })
            // Rolled back: the task stays open and nothing about the bid is written.
            if (refusal) tx.rollback()
          }
          await appendEvent(
            tx,
            ev('task.resolved', { kind: 'task', id: taskId }, l.correlationId, 'boris', { action }),
          )
          if (action === 'skip') {
            await tx.update(lead).set({ status: 'skipped' }).where(eq(lead.id, l.id))
            await appendEvent(
              tx,
              ev('lead.skipped', { kind: 'lead', id: l.id }, l.correlationId, 'boris'),
            )
          } else {
            // Checked above; should the draft be gone, the whole decision rolls back rather than bid without it.
            if (text === null) throw new Error('a bid without its text')
            // Boris's decision and the intent to bid commit together: a crash cannot lose one of them.
            outboxId = (
              await recordBid(tx, {
                leadId: l.id,
                accountId: l.accountId,
                text,
                correlationId: l.correlationId,
                title: l.title,
                priceRub: l.bidPriceRub,
                servicePriceRub: l.draftPriceRub,
                taskId,
              })
            ).outboxId
          }
          return true
        })
        .catch((e) => {
          // The rollback of a refused bid; anything else is a real failure.
          if (refusal) return false
          throw e
        })
      if (refusal) return refusal
      if (!resolved) return TEXTS.alreadyDone
      await deliverDecision(taskId, action)
      if (outboxId) await startOutboxDelivery(outboxId, l.id)
      learnFrom(
        { leadId: l.id, label: action === 'bid' ? 'yes' : 'no', source: 'card' },
        'why_skip',
        l.title,
      )
      return action === 'skip' ? TEXTS.skipped : TEXTS.bidQueued
    },

    async onReminder(taskId) {
      const card = await cardOfTask(taskId, true)
      if (!card) return
      await d().notifier.sendLeadCard(card, { silent: await quietNow(d().db, new Date()) })
      const found = await leadOfTask(taskId)
      if (found) {
        await appendEvent(
          d().db,
          ev('task.reminded', { kind: 'task', id: taskId }, found.lead.correlationId, 'sara'),
        )
      }
    },

    async resendCard(taskId) {
      const card = await cardOfTask(taskId, false)
      if (card)
        await d().notifier.sendLeadCard(card, { silent: await quietNow(d().db, new Date()) })
    },

    onDraftText,
  }
}
