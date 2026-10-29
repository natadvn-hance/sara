import { DBOS } from '@dbos-inc/dbos-sdk'
import { formatRub, newEventId } from '@sara/shared'
import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { bidHold, lead, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { Notifier } from '../notify/notifier'
import type { Press } from '../tasks/resolve'

/**
 * A bid from the pult with ten seconds to change one's mind (pult v2 design 4, M7 design 6.3). The hold lives in
 * the core, not in the phone: a row with its state and a durable process that fires it, so a closed Mini App
 * does not lose the bid and «Отменить» from any device still stops it. The press that fires is the same as the
 * Telegram button's, through the resolver, with every check of money and pauses.
 */

export const HOLD_MS = 10_000

export const HOLD_TEXTS = {
  held: (fee: number) => `Откликаюсь за ${formatRub(fee)} через 10 секунд. Можно отменить.`,
  heldNoFee: 'Откликаюсь через 10 секунд. Можно отменить.',
  cancelled: 'Отменила, отклик не ушёл.',
  gone: 'Отклик уже ушёл.',
  nothing: 'Отсрочки нет: отклик не стоял в очереди.',
  decided: 'Заявка уже решена.',
  noTask: 'Такой заявки в очереди нет.',
  notSent: (title: string, why: string) => `Отклик на «${title}» не ушёл: ${why}`,
} as const

export type HoldDeps = {
  db: Db
  /** Ten seconds; tests use less. */
  holdMs?: number
  /** The press the hold fires: the resolver, with `source: 'hold'`. */
  press(p: Press): Promise<string>
  /** Boris is told when a fired hold did not end in a bid (the task stayed open). */
  notifier: Pick<Notifier, 'sendText'>
  /** Starts the durable wait; tests pass their own. */
  start?(requestId: string, executeAt: string): Promise<void>
  now?(): Date
}

let deps: HoldDeps | null = null
export function setHoldDeps(d: HoldDeps): void {
  deps = d
}
function d(): HoldDeps {
  if (!deps) throw new Error('bid holds are not configured')
  return deps
}

const workflowId = (requestId: string) => `held-bid:${requestId}`
/** A time read back from Postgres («2026-10-29 16:40:37+00») as the ISO the screens and the wait use. */
const iso = (at: string) => new Date(at).toISOString()

/** The row of a lead's open decision task; null when there is none. */
async function openTaskOf(db: Db, leadId: string) {
  const [t] = await db
    .select()
    .from(task)
    .where(and(eq(task.entityId, leadId), eq(task.kind, 'lead_decision'), eq(task.state, 'open')))
    .orderBy(desc(task.createdAt))
    .limit(1)
  return t ?? null
}

/** The hold of a task that still waits, for the screens. */
export async function heldOf(
  db: Db,
  taskId: string,
): Promise<{ requestId: string; executeAt: string } | null> {
  const [h] = await db.select().from(bidHold).where(eq(bidHold.taskId, taskId))
  return h && h.state === 'held' ? { requestId: h.requestId, executeAt: iso(h.executeAt) } : null
}

/**
 * «Откликнуться» from the pult: the row goes to `held` with a new request (a second tap meanwhile returns the same
 * hold), the event `bid.held` is written, and the durable wait starts.
 */
export async function holdBid(
  leadId: string,
  expectedFeeRub: number,
): Promise<
  | { ok: true; message: string; executeAt: string }
  | { ok: false; status: number; message: string; code?: string }
> {
  const db = d().db
  const t = await openTaskOf(db, leadId)
  if (!t) return { ok: false, status: 409, message: HOLD_TEXTS.decided }
  const [l] = await db.select().from(lead).where(eq(lead.id, leadId))
  if (!l) return { ok: false, status: 404, message: HOLD_TEXTS.noTask }
  if (l.bidPriceRub !== expectedFeeRub)
    return {
      ok: false,
      status: 409,
      code: 'fee_changed',
      message: `Цена изменилась: было ${formatRub(expectedFeeRub)}, стало ${formatRub(l.bidPriceRub)}. Нажми ещё раз.`,
    }
  const now = d().now?.() ?? new Date()
  const executeAt = new Date(now.getTime() + (d().holdMs ?? HOLD_MS)).toISOString()
  const requestId = newEventId()
  const made = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(bidHold).where(eq(bidHold.taskId, t.id)).for('update')
    if (existing?.state === 'held')
      return { requestId: existing.requestId, executeAt: iso(existing.executeAt), fresh: false }
    if (existing)
      await tx
        .update(bidHold)
        .set({ requestId, state: 'held', expectedFeeRub, executeAt, updatedAt: now.toISOString() })
        .where(eq(bidHold.taskId, t.id))
    else
      await tx
        .insert(bidHold)
        .values({ taskId: t.id, requestId, state: 'held', expectedFeeRub, executeAt })
    await appendEvent(tx, {
      type: 'bid.held',
      v: 1,
      entity: { kind: 'lead', id: leadId },
      account_id: l.accountId,
      actor: 'boris',
      occurred_at: now.toISOString(),
      causation_id: null,
      correlation_id: l.correlationId,
      reason: null,
      payload: {
        task_id: t.id,
        request_id: requestId,
        fee_rub: expectedFeeRub,
        execute_at: executeAt,
      },
    })
    return { requestId, executeAt, fresh: true }
  })
  if (made.fresh) await (d().start ?? startHoldWorkflow)(made.requestId, made.executeAt)
  return {
    ok: true,
    message: l.bidPriceRub > 0 ? HOLD_TEXTS.held(l.bidPriceRub) : HOLD_TEXTS.heldNoFee,
    executeAt: made.executeAt,
  }
}

/** «Отменить»: one row changed means cancelled; none means the bid already fired, or nothing was held. */
export async function cancelHold(leadId: string): Promise<{ ok: boolean; message: string }> {
  const db = d().db
  const t = await openTaskOf(db, leadId)
  const [h] = t ? await db.select().from(bidHold).where(eq(bidHold.taskId, t.id)) : []
  if (!t || !h) {
    // The task is gone: the bid went, or it was decided another way.
    const [last] = await db
      .select({ h: bidHold })
      .from(bidHold)
      .innerJoin(task, eq(task.id, bidHold.taskId))
      .where(eq(task.entityId, leadId))
      .orderBy(desc(bidHold.updatedAt))
      .limit(1)
    return { ok: false, message: last?.h.state === 'fired' ? HOLD_TEXTS.gone : HOLD_TEXTS.nothing }
  }
  const now = new Date().toISOString()
  const rows = await db
    .update(bidHold)
    .set({ state: 'cancelled', updatedAt: now })
    .where(and(eq(bidHold.taskId, t.id), eq(bidHold.state, 'held')))
    .returning({ requestId: bidHold.requestId })
  if (rows.length === 0)
    return { ok: false, message: h.state === 'fired' ? HOLD_TEXTS.gone : HOLD_TEXTS.nothing }
  const [l] = await db.select().from(lead).where(eq(lead.id, leadId))
  await appendEvent(db, {
    type: 'bid.hold_cancelled',
    v: 1,
    entity: { kind: 'lead', id: leadId },
    account_id: l?.accountId ?? null,
    actor: 'boris',
    occurred_at: now,
    causation_id: null,
    correlation_id: l?.correlationId ?? newEventId(),
    reason: null,
    payload: { task_id: t.id, request_id: rows[0]?.requestId },
  })
  return { ok: true, message: HOLD_TEXTS.cancelled }
}

/**
 * The hold fires: the row goes to `fired` only from `held` (zero rows means it was cancelled), then the press. A
 * press that left the task open (a pause, money) is told to Boris, as the Telegram button would have answered him.
 */
export async function fireHold(requestId: string): Promise<string | null> {
  const db = d().db
  const now = new Date().toISOString()
  const rows = await db
    .update(bidHold)
    .set({ state: 'fired', updatedAt: now })
    .where(and(eq(bidHold.requestId, requestId), eq(bidHold.state, 'held')))
    .returning({ taskId: bidHold.taskId })
  const taskId = rows[0]?.taskId
  if (!taskId) return null
  const answer = await d().press({ taskId, action: 'bid', source: 'hold' })
  const [t] = await db.select().from(task).where(eq(task.id, taskId))
  if (t?.state === 'open') {
    const [l] = await db.select({ title: lead.title }).from(lead).where(eq(lead.id, t.entityId))
    await d()
      .notifier.sendText(HOLD_TEXTS.notSent(l?.title ?? 'заявку', answer), {
        notice: { kind: 'lead', link: `/leads/${encodeURIComponent(t.entityId)}`, taskId },
      })
      .catch((e: unknown) =>
        console.error('hold answer not sent', e instanceof Error ? e.message.slice(0, 200) : e),
      )
  }
  return answer
}

async function heldBid(requestId: string, executeAt: string): Promise<void> {
  const wait = Date.parse(executeAt) - Date.now()
  if (wait > 0) await DBOS.sleep(wait)
  await DBOS.runStep(() => fireHold(requestId), {
    name: 'fire',
    retriesAllowed: true,
    maxAttempts: 3,
    intervalSeconds: 1,
  })
}

const heldBidWorkflow = DBOS.registerWorkflow(heldBid, { name: 'heldBid' })

export async function startHoldWorkflow(requestId: string, executeAt: string): Promise<void> {
  await DBOS.startWorkflow(heldBidWorkflow, { workflowID: workflowId(requestId) })(
    requestId,
    executeAt,
  )
}
