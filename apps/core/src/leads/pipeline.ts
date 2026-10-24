import { DBOS } from '@dbos-inc/dbos-sdk'
import { type EventEnvelope, newEventId, ProfiOrder, type TaskAction } from '@sara/shared'
import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { event, lead, leadScore, task } from '../db/schema'
import { activeRules } from '../direction/store'
import type { Gateway } from '../gateway/gateway'
import { appendEvent } from '../journal/journal'
import { recordLabel } from '../learning/labels'
import { onProposalPress } from '../learning/proposals'
import { askWhy } from '../learning/questions'
import type { LeadCard } from '../notify/cards'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import type { ProfiClient } from '../profi/client'
import { getSetting } from '../settings/store'
import { deliverDecision, startDecisionWait } from '../workflows/decisionWait'
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
}

/** Database steps may hit a passing database error; they are safe to repeat. */
const DB_STEP = { retriesAllowed: true, maxAttempts: 3, intervalSeconds: 1 }

let deps: LeadPipelineDeps | null = null
function d(): LeadPipelineDeps {
  if (!deps) throw new Error('lead pipeline is not configured')
  return deps
}

export function bidText(title: string): string {
  return `Добрый день! Агентство Hance, готовы помочь с задачей «${title}». Расскажите, пожалуйста, подробнее.`
}

const ev = (
  type:
    | 'lead.found'
    | 'lead.sorted'
    | 'lead.scored'
    | 'lead.skipped'
    | 'task.created'
    | 'task.resolved'
    | 'task.reminded',
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

/** One order, one durable run (workflow id lead:<order>): record, sort, card, wait for Boris. */
async function processOrder(e: EventEnvelope): Promise<void> {
  const order = ProfiOrder.parse(e.payload)
  const correlationId = e.correlation_id
  const isNew = await DBOS.runStep(
    () =>
      d().db.transaction(async (tx) => {
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
          })
          .onConflictDoNothing({ target: lead.id })
          .returning({ id: lead.id })
        if (rows.length === 0) return false
        await appendEvent(
          tx,
          ev('lead.found', { kind: 'lead', id: order.order_id }, correlationId, 'sara', {}, e.id),
        )
        return true
      }),
    { name: 'record', ...DB_STEP },
  )
  if (!isNew) return

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

  const taskId = await DBOS.runStep(
    () =>
      d().db.transaction(async (tx) => {
        const id = newEventId()
        if (sorted.verdict) {
          await appendEvent(
            tx,
            ev('lead.sorted', { kind: 'lead', id: order.order_id }, correlationId, 'sara', sorted),
          )
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
  }
  const retry = d().notifyRetry ?? { maxAttempts: 5, intervalSeconds: 2 }
  try {
    await DBOS.runStep(
      async () => {
        const m = await d().notifier.sendLeadCard(card)
        await d().db.update(task).set({ telegramMessageId: m.messageId }).where(eq(task.id, taskId))
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
  }
}

/**
 * «Взял бы» from the daily summary: Boris's yes on an order Sara dropped. It is a label and a surprise («почему?»),
 * and the order comes back as a normal card so he can bid on it.
 */
async function onWant(reviewId: string): Promise<string> {
  const [t] = await d().db.select().from(task).where(eq(task.id, reviewId))
  if (!t || t.kind !== 'lead_review') return TEXTS.alreadyDone
  const [l] = await d().db.select().from(lead).where(eq(lead.id, t.entityId))
  if (!l) return TEXTS.alreadyDone
  const decisionId = newEventId()
  const resolved = await d().db.transaction(async (tx) => {
    const rows = await tx
      .update(task)
      .set({ state: 'resolved', resolution: 'want', resolvedAt: new Date().toISOString() })
      .where(and(eq(task.id, reviewId), eq(task.state, 'open')))
      .returning({ id: task.id })
    if (rows.length === 0) return false
    await appendEvent(
      tx,
      ev('task.resolved', { kind: 'task', id: reviewId }, l.correlationId, 'boris', {
        action: 'want',
      }),
    )
    await tx
      .insert(task)
      .values({ id: decisionId, kind: 'lead_decision', entityKind: 'lead', entityId: l.id })
    await tx.update(lead).set({ status: 'queued' }).where(eq(lead.id, l.id))
    await appendEvent(
      tx,
      ev('task.created', { kind: 'task', id: decisionId }, l.correlationId, 'sara', {
        lead_id: l.id,
      }),
    )
    return true
  })
  if (!resolved) return TEXTS.alreadyDone
  await startDecisionWait(decisionId, await d().remindAfterMs())
  const card = await cardOfTask(decisionId, false)
  if (card) {
    const m = await d().notifier.sendLeadCard(card)
    await d().db.update(task).set({ telegramMessageId: m.messageId }).where(eq(task.id, decisionId))
  }
  learnFrom({ leadId: l.id, label: 'yes', source: 'summary' }, 'why_want', l.title)
  return TEXTS.wantCard
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
      if (action === 'apply' || action === 'drop') return onProposalPress(d(), taskId, action)
      if (action !== 'bid' && action !== 'skip') return TEXTS.alreadyDone
      const found = await leadOfTask(taskId)
      if (!found) return TEXTS.alreadyDone
      const { lead: l } = found
      // Paused or refused for money: nothing is decided, the card stays usable for a press later.
      let wallet: number | null = null
      if (action === 'bid' && found.task.state === 'open') {
        if (!(await getSetting(d().db, 'outbound.bids'))) return TEXTS.bidsPausedPress
        wallet = await readWallet(d().profi, l.accountId)
      }
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
            // Boris's decision and the intent to bid commit together: a crash cannot lose one of them.
            outboxId = (
              await recordBid(tx, {
                leadId: l.id,
                accountId: l.accountId,
                text: bidText(l.title),
                correlationId: l.correlationId,
                title: l.title,
                priceRub: l.bidPriceRub,
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
      await d().notifier.sendLeadCard(card)
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
      if (card) await d().notifier.sendLeadCard(card)
    },
  }
}
