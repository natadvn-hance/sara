import { DBOS } from '@dbos-inc/dbos-sdk'
import { type EventEnvelope, newEventId, ProfiOrder, type TaskAction } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { lead, task } from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import { appendEvent } from '../journal/journal'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { deliverDecision, startDecisionWait } from '../workflows/decisionWait'
import { enqueueBid } from './outbox'
import { sortOrder } from './sorter'

export type LeadPipelineDeps = {
  db: Db
  gateway: Gateway
  notifier: Notifier
  remindAfterMs: () => Promise<number>
}

export type LeadPipeline = {
  onOrderSeen(e: EventEnvelope): Promise<void>
  onPress(p: { taskId: string; action: TaskAction }): Promise<string>
  onReminder(taskId: string): Promise<void>
}

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
    { name: 'record' },
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
      { name: 'sortedOut' },
    )
    return
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
    { name: 'task' },
  )

  // The wait starts before the card goes out, so an instant press always finds it.
  const remindAfter = await DBOS.runStep(() => d().remindAfterMs(), { name: 'remindAfter' })
  await startDecisionWait(taskId, remindAfter)

  await DBOS.runStep(
    async () => {
      const m = await d().notifier.sendLeadCard({
        taskId,
        title: order.title,
        city: order.city,
        verdict: sorted.verdict === 'reject' ? null : sorted.verdict,
        reason: sorted.reason,
        bidPriceRub: order.bid_price_rub,
      })
      await d().db.update(task).set({ telegramMessageId: m.messageId }).where(eq(task.id, taskId))
    },
    { name: 'card' },
  )
}

const processOrderWorkflow = DBOS.registerWorkflow(processOrder, { name: 'processOrder' })

async function leadOfTask(taskId: string) {
  const [t] = await d().db.select().from(task).where(eq(task.id, taskId))
  if (!t) return null
  const [l] = await d().db.select().from(lead).where(eq(lead.id, t.entityId))
  return l ? { task: t, lead: l } : null
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
      const found = await leadOfTask(taskId)
      if (!found) return TEXTS.alreadyDone
      const { lead: l } = found
      const resolved = await d().db.transaction(async (tx) => {
        const rows = await tx
          .update(task)
          .set({ state: 'resolved', resolution: action, resolvedAt: new Date().toISOString() })
          .where(and(eq(task.id, taskId), eq(task.state, 'open')))
          .returning({ id: task.id })
        if (rows.length === 0) return false
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
        }
        return true
      })
      if (!resolved) return TEXTS.alreadyDone
      await deliverDecision(taskId, action)
      if (action === 'skip') return TEXTS.skipped
      if (action === 'bid') {
        await enqueueBid(d().db, {
          leadId: l.id,
          accountId: l.accountId,
          text: bidText(l.title),
          correlationId: l.correlationId,
          title: l.title,
          priceRub: l.bidPriceRub,
        })
        return TEXTS.bidQueued
      }
      return TEXTS.alreadyDone
    },

    async onReminder(taskId) {
      const found = await leadOfTask(taskId)
      if (!found || found.task.state !== 'open') return
      await d().notifier.sendText(TEXTS.reminder(found.lead.title))
      await appendEvent(
        d().db,
        ev('task.reminded', { kind: 'task', id: taskId }, found.lead.correlationId, 'sara'),
      )
    },
  }
}
