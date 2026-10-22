import { DBOS } from '@dbos-inc/dbos-sdk'
import { type EventType, newEventId } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { lead, outbox, task } from '../db/schema'
import { createDeal } from '../domain/deal'
import { appendEvent } from '../journal/journal'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { type ProfiClient, ProfiError } from '../profi/client'
import { getSetting } from '../settings/store'

export type OutboxDeps = {
  db: Db
  profi: ProfiClient
  notifier: Notifier
  retryDelaysMs: number[]
  /** Called when a paused bid gives the order back to Boris: resend its card. */
  resendCard(taskId: string): Promise<void>
}

let deps: OutboxDeps | null = null
export function setOutboxDeps(d: OutboxDeps): void {
  deps = d
}
function d(): OutboxDeps {
  if (!deps) throw new Error('outbox is not configured')
  return deps
}

export type BidPayload = {
  leadId: string
  accountId: string
  text: string
  correlationId: string
  title: string
  priceRub: number
  taskId?: string
}

/** Database steps may hit a passing database error; they are safe to repeat. */
const DB_STEP = { retriesAllowed: true, maxAttempts: 3, intervalSeconds: 1 }

function ev(
  type: EventType,
  p: BidPayload,
  entity: { kind: string; id: string },
  payload: Record<string, unknown> = {},
  reason: string | null = null,
) {
  return {
    type,
    v: 1,
    entity,
    account_id: p.accountId,
    actor: 'sara' as const,
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: p.correlationId,
    reason,
    payload,
  }
}

const keyOf = (leadId: string) => `bid:${leadId}`
const workflowIdOf = (key: string) => `outbox:${key}`

/**
 * Records the intent to bid inside the caller's transaction (together with Boris's decision), once per
 * order: key bid:<order>, FR-LEAD-4. Delivery starts after the commit with startOutboxDelivery.
 */
export async function recordBid(
  tx: DbOrTx,
  p: BidPayload,
): Promise<{ outboxId: string; created: boolean }> {
  const id = newEventId()
  const rows = await tx
    .insert(outbox)
    .values({ id, kind: 'bid', idempotencyKey: keyOf(p.leadId), payload: p })
    .onConflictDoNothing({ target: outbox.idempotencyKey })
    .returning({ id: outbox.id })
  if (rows.length === 0) {
    const [existing] = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(eq(outbox.idempotencyKey, keyOf(p.leadId)))
    return { outboxId: existing?.id ?? id, created: false }
  }
  await appendEvent(tx, ev('outbox.queued', p, { kind: 'outbox', id }))
  await appendEvent(tx, ev('bid.requested', p, { kind: 'lead', id: p.leadId }))
  return { outboxId: id, created: true }
}

export async function startOutboxDelivery(outboxId: string, leadId: string): Promise<void> {
  await DBOS.startWorkflow(deliverWorkflow, { workflowID: workflowIdOf(keyOf(leadId)) })(outboxId)
}

/** On start: delivers bids recorded before a crash that never got their delivery started. */
export async function resumeQueuedOutbox(db: Db): Promise<number> {
  const rows = await db.select().from(outbox).where(eq(outbox.state, 'queued'))
  for (const r of rows) await startOutboxDelivery(r.id, (r.payload as BidPayload).leadId)
  return rows.length
}

/** Marks the bid as sent exactly once; a repeat (for example a re-run step after a crash) returns false. */
export async function confirmBid(
  db: Db,
  outboxId: string,
  r: { spent: number; balanceAfter: number | null },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(outbox)
      .set({ state: 'confirmed', confirmedAt: new Date().toISOString() })
      .where(and(eq(outbox.id, outboxId), eq(outbox.state, 'queued')))
      .returning({ payload: outbox.payload })
    const row = rows[0]
    if (!row) return false
    const p = row.payload as BidPayload
    await appendEvent(tx, ev('outbox.confirmed', p, { kind: 'outbox', id: outboxId }))
    await appendEvent(tx, ev('bid.sent', p, { kind: 'lead', id: p.leadId }, { spent_rub: r.spent }))
    await appendEvent(
      tx,
      ev(
        'spend.recorded',
        p,
        { kind: 'lead', id: p.leadId },
        { amount_rub: r.spent, balance_after_rub: r.balanceAfter },
      ),
    )
    await tx.update(lead).set({ status: 'bid_sent' }).where(eq(lead.id, p.leadId))
    await createDeal(tx, {
      leadId: p.leadId,
      accountId: p.accountId,
      correlationId: p.correlationId,
    })
    return true
  })
}

async function markNotSent(
  outboxId: string,
  p: BidPayload,
  state: 'failed' | 'uncertain',
  errorClass: string,
): Promise<void> {
  await d().db.transaction(async (tx) => {
    const rows = await tx
      .update(outbox)
      .set({ state, errorClass })
      .where(and(eq(outbox.id, outboxId), eq(outbox.state, 'queued')))
      .returning({ id: outbox.id })
    if (rows.length === 0) return
    await appendEvent(
      tx,
      ev('outbox.failed', p, { kind: 'outbox', id: outboxId }, { errorClass, state }),
    )
    await appendEvent(
      tx,
      ev(
        'bid.failed',
        p,
        { kind: 'lead', id: p.leadId },
        { reason: errorClass, uncertain: state === 'uncertain' },
        errorClass,
      ),
    )
  })
}

/** Paused between the press and the delivery: nothing was sent, so the order goes back to Boris. */
async function giveBack(outboxId: string, p: BidPayload): Promise<void> {
  await d().db.transaction(async (tx) => {
    await tx.delete(outbox).where(and(eq(outbox.id, outboxId), eq(outbox.state, 'queued')))
    await appendEvent(
      tx,
      ev('bid.failed', p, { kind: 'lead', id: p.leadId }, { reason: 'paused' }, 'paused'),
    )
    if (p.taskId) {
      await tx
        .update(task)
        .set({ state: 'open', resolution: null, resolvedAt: null })
        .where(eq(task.id, p.taskId))
    }
    await tx.update(lead).set({ status: 'queued' }).where(eq(lead.id, p.leadId))
  })
}

async function tell(text: string, p: BidPayload): Promise<void> {
  try {
    await d().notifier.sendText(text)
  } catch (err) {
    await appendEvent(d().db, {
      ...ev('notify.failed', p, { kind: 'lead', id: p.leadId }, { channel: 'telegram' }),
      reason: err instanceof Error ? err.message.slice(0, 200) : 'message was not sent',
    })
  }
}

type Attempt =
  | { kind: 'ok'; spent: number; balanceAfter: number | null }
  | { kind: 'uncertain' }
  | { kind: 'failed'; errorClass: string }

async function deliver(outboxId: string): Promise<void> {
  const [row] = await DBOS.runStep(
    () => d().db.select().from(outbox).where(eq(outbox.id, outboxId)),
    { name: 'load', ...DB_STEP },
  )
  if (!row || row.state !== 'queued') return
  const p = row.payload as BidPayload

  const allowed = await DBOS.runStep(() => getSetting(d().db, 'outbound.bids'), {
    name: 'checkPause',
    ...DB_STEP,
  })
  if (!allowed) {
    await DBOS.runStep(() => giveBack(outboxId, p), { name: 'giveBack', ...DB_STEP })
    await DBOS.runStep(() => tell(TEXTS.bidsPaused, p), { name: 'tellPaused' })
    if (p.taskId) {
      const taskId = p.taskId
      await DBOS.runStep(
        () =>
          d()
            .resendCard(taskId)
            .catch(() => {}),
        { name: 'resendCard' },
      )
    }
    return
  }

  const delays = d().retryDelaysMs
  let result: Attempt = { kind: 'uncertain' }
  for (let i = 0; i <= delays.length; i++) {
    result = await DBOS.runStep(
      async (): Promise<Attempt> => {
        await d()
          .db.update(outbox)
          .set({ attempts: i + 1 })
          .where(eq(outbox.id, outboxId))
        try {
          const r = await d().profi.submitBid({
            account_id: p.accountId,
            order_id: p.leadId,
            text: p.text,
            idempotency_key: row.idempotencyKey,
          })
          return { kind: 'ok', spent: r.spent_rub, balanceAfter: r.balance_after_rub }
        } catch (e) {
          if (e instanceof ProfiError && e.errorClass !== 'UNCERTAIN')
            return { kind: 'failed', errorClass: e.errorClass }
          return { kind: 'uncertain' }
        }
      },
      { name: `submit-${i}` },
    )
    if (result.kind !== 'uncertain') break
    const delay = delays[i]
    if (delay !== undefined) await DBOS.sleep(delay)
  }

  const final = result
  if (final.kind === 'ok') {
    const first = await DBOS.runStep(() => confirmBid(d().db, outboxId, final), {
      name: 'confirm',
      ...DB_STEP,
    })
    if (first)
      await DBOS.runStep(() => tell(TEXTS.bidSent(p.title, p.priceRub), p), { name: 'tellSent' })
  } else if (final.kind === 'uncertain') {
    // The bid may be on the site: never say it failed, or Boris bids again by hand.
    await DBOS.runStep(() => markNotSent(outboxId, p, 'uncertain', 'UNCERTAIN'), {
      name: 'markUncertain',
      ...DB_STEP,
    })
    await DBOS.runStep(() => tell(TEXTS.bidUncertain, p), { name: 'tellUncertain' })
  } else {
    await DBOS.runStep(() => markNotSent(outboxId, p, 'failed', final.errorClass), {
      name: 'markFailed',
      ...DB_STEP,
    })
    await DBOS.runStep(() => tell(TEXTS.bidFailed, p), { name: 'tellFailed' })
  }
}

const deliverWorkflow = DBOS.registerWorkflow(deliver, { name: 'deliverOutbox' })
