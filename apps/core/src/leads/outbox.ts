import { DBOS } from '@dbos-inc/dbos-sdk'
import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { lead, outbox } from '../db/schema'
import { createDeal } from '../domain/deal'
import { appendEvent } from '../journal/journal'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { type ProfiClient, ProfiError } from '../profi/client'
import { getSetting } from '../settings/store'

export type OutboxDeps = { db: Db; profi: ProfiClient; notifier: Notifier; retryDelaysMs: number[] }

let deps: OutboxDeps | null = null
export function setOutboxDeps(d: OutboxDeps): void {
  deps = d
}
function d(): OutboxDeps {
  if (!deps) throw new Error('outbox is not configured')
  return deps
}

type BidPayload = {
  leadId: string
  accountId: string
  text: string
  correlationId: string
  title: string
  priceRub: number
}

const event = (
  type:
    | 'outbox.queued'
    | 'outbox.confirmed'
    | 'outbox.failed'
    | 'bid.requested'
    | 'bid.sent'
    | 'bid.failed'
    | 'spend.recorded',
  p: BidPayload,
  entity: { kind: string; id: string },
  payload: Record<string, unknown> = {},
  reason: string | null = null,
) => ({
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
})

type Attempt =
  | { kind: 'ok'; spent: number; balanceAfter: number | null }
  | { kind: 'uncertain' }
  | { kind: 'failed'; errorClass: string }

async function deliver(outboxId: string): Promise<void> {
  const [row] = await DBOS.runStep(
    () => d().db.select().from(outbox).where(eq(outbox.id, outboxId)),
    { name: 'load' },
  )
  if (!row || row.state !== 'queued') return
  const p = row.payload as BidPayload

  const allowed = await DBOS.runStep(() => getSetting(d().db, 'outbound.bids'), {
    name: 'checkPause',
  })
  if (!allowed) {
    await DBOS.runStep(
      async () => {
        await d().db.transaction(async (tx) => {
          await tx
            .update(outbox)
            .set({ state: 'failed', errorClass: 'paused' })
            .where(eq(outbox.id, outboxId))
          await appendEvent(
            tx,
            event('bid.failed', p, { kind: 'lead', id: p.leadId }, { reason: 'paused' }, 'paused'),
          )
        })
        await d().notifier.sendText(TEXTS.bidsPaused)
      },
      { name: 'paused' },
    )
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
  await DBOS.runStep(
    async () => {
      if (final.kind === 'ok') {
        await d().db.transaction(async (tx) => {
          await tx
            .update(outbox)
            .set({ state: 'confirmed', confirmedAt: new Date().toISOString() })
            .where(eq(outbox.id, outboxId))
          await appendEvent(tx, event('outbox.confirmed', p, { kind: 'outbox', id: outboxId }))
          await appendEvent(
            tx,
            event('bid.sent', p, { kind: 'lead', id: p.leadId }, { spent_rub: final.spent }),
          )
          await appendEvent(
            tx,
            event(
              'spend.recorded',
              p,
              { kind: 'lead', id: p.leadId },
              { amount_rub: final.spent, balance_after_rub: final.balanceAfter },
            ),
          )
          await tx.update(lead).set({ status: 'bid_sent' }).where(eq(lead.id, p.leadId))
          await createDeal(tx, {
            leadId: p.leadId,
            accountId: p.accountId,
            correlationId: p.correlationId,
          })
        })
        await d().notifier.sendText(TEXTS.bidSent(p.title, p.priceRub))
      } else {
        const errorClass = final.kind === 'failed' ? final.errorClass : 'UNCERTAIN'
        await d().db.transaction(async (tx) => {
          await tx
            .update(outbox)
            .set({ state: 'failed', errorClass })
            .where(eq(outbox.id, outboxId))
          await appendEvent(
            tx,
            event('outbox.failed', p, { kind: 'outbox', id: outboxId }, { errorClass }),
          )
          await appendEvent(
            tx,
            event(
              'bid.failed',
              p,
              { kind: 'lead', id: p.leadId },
              { reason: errorClass },
              errorClass,
            ),
          )
        })
        await d().notifier.sendText(TEXTS.bidFailed)
      }
    },
    { name: 'finish' },
  )
}

const deliverWorkflow = DBOS.registerWorkflow(deliver, { name: 'deliverOutbox' })

/** Records the intent to bid once per order (key bid:<order>, FR-LEAD-4) and starts its durable delivery. */
export async function enqueueBid(
  db: Db,
  p: BidPayload,
): Promise<{ outboxId: string; created: boolean }> {
  const key = `bid:${p.leadId}`
  const id = newEventId()
  const created = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(outbox)
      .values({ id, kind: 'bid', idempotencyKey: key, payload: p })
      .onConflictDoNothing({ target: outbox.idempotencyKey })
      .returning({ id: outbox.id })
    if (rows.length === 0) return false
    await appendEvent(tx, event('outbox.queued', p, { kind: 'outbox', id }))
    await appendEvent(tx, event('bid.requested', p, { kind: 'lead', id: p.leadId }))
    return true
  })
  if (!created) {
    const [existing] = await db
      .select({ id: outbox.id })
      .from(outbox)
      .where(eq(outbox.idempotencyKey, key))
    return { outboxId: existing?.id ?? id, created: false }
  }
  await DBOS.startWorkflow(deliverWorkflow, { workflowID: `outbox:${id}` })(id)
  return { outboxId: id, created: true }
}
