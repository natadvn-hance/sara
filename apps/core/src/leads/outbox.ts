import { DBOS } from '@dbos-inc/dbos-sdk'
import { type EventType, newEventId, type ProfiErrorClass } from '@sara/shared'
import { and, eq, or, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { lead, outbox, task } from '../db/schema'
import { lostRoute } from '../direction/router'
import { createDeal } from '../domain/deal'
import { appendEvent } from '../journal/journal'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { type ProfiClient, ProfiError } from '../profi/client'
import { getSetting } from '../settings/store'
import { bidTextAt } from './draft'

export type OutboxDeps = {
  db: Db
  profi: Pick<ProfiClient, 'submitBid' | 'getOrder'>
  notifier: Notifier
  retryDelaysMs: number[]
  /** A busy account tab (RATE_LIMITED, nothing pressed): how long to wait between tries and how many times. */
  busyRetry: { delayMs: number; tries: number }
  /** An unsure bid is looked for on its order page (get_order) after each of these waits. */
  reconcileDelaysMs: number[]
  /** Called when a bid that was not pressed gives the order back to Boris: resend its card. */
  resendCard(taskId: string): Promise<void>
  /** Called when a bid ended ORDER_CLOSED: the card of that order is closed in Telegram (FR-LEAD-5). */
  closeCard(taskId: string): Promise<void>
  /** The clock of the greeting: a bid is greeted at the moment it is sent (Moscow time of day). Tests fix it. */
  now?: () => Date
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
  /** The draft as it was when Boris pressed: its greeting is the one of that hour and is built again when the bid is sent. */
  text: string
  /** The client's name on the board, for a draft with no greeting of its own; absent in rows from before 26.10.2026. */
  clientName?: string
  correlationId: string
  title: string
  /** What the bid itself costs on Profi.ru, as on the card Boris pressed: the most the node may pay. */
  priceRub: number
  /** The «Стоимость услуги» typed into the form; null or absent (rows from before M2) leaves it empty. */
  servicePriceRub?: number | null
  taskId?: string
}

/** Database steps may hit a passing database error; they are safe to repeat. */
const DB_STEP = { retriesAllowed: true, maxAttempts: 3, intervalSeconds: 1 }

/** A press still queued after this long when the core starts again is given back, not sent hours late. */
const STALE_PRESS = '1 hour'

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

/** The node's idempotency key: one per order, whatever happens to the outbox rows (FR-LEAD-4). */
const keyOf = (leadId: string) => `bid:${leadId}`
/**
 * One durable run per outbox row (B3): a row given back and pressed again is a new row, so it gets its own run.
 * Runs started before 25.10.2026 were named by the order (outbox:bid:<order>) and DBOS resumes them by that name.
 */
const workflowIdOf = (outboxId: string) => `outbox:${outboxId}`
const legacyWorkflowIdOf = (leadId: string) => `outbox:${keyOf(leadId)}`

/**
 * Records the intent to bid inside the caller's transaction (together with Boris's decision), once per
 * order: key bid:<order>, FR-LEAD-4. Delivery starts after the commit with startOutboxDelivery.
 */
export async function recordBid(
  tx: DbOrTx,
  p: BidPayload,
): Promise<{ outboxId: string | null; created: boolean }> {
  // An order another direction won is not this account's to bid on, whatever the card in front of Boris says.
  if (await lostRoute(tx, p.leadId, p.accountId)) return { outboxId: null, created: false }
  const id = newEventId()
  const rows = await tx
    .insert(outbox)
    .values({ id, kind: 'bid', idempotencyKey: keyOf(p.leadId), payload: p })
    // Any unique rule: the key, and the one bid per order of the table itself.
    .onConflictDoNothing()
    .returning({ id: outbox.id })
  if (rows.length === 0) {
    const [existing] = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        or(
          eq(outbox.idempotencyKey, keyOf(p.leadId)),
          and(eq(outbox.kind, 'bid'), sql`${outbox.payload}->>'leadId' = ${p.leadId}`),
        ),
      )
    return { outboxId: existing?.id ?? id, created: false }
  }
  await appendEvent(tx, ev('outbox.queued', p, { kind: 'outbox', id }))
  await appendEvent(tx, ev('bid.requested', p, { kind: 'lead', id: p.leadId }))
  return { outboxId: id, created: true }
}

export async function startOutboxDelivery(outboxId: string): Promise<void> {
  await DBOS.startWorkflow(deliverWorkflow, { workflowID: workflowIdOf(outboxId) })(outboxId)
}

const RUNNING = ['PENDING', 'ENQUEUED']

/**
 * On start: delivers bids recorded before a crash that never got their delivery started. A row whose run DBOS
 * resumes itself is left to it. A row that never had a run, old or new, and waited over an hour goes back to Boris;
 * one whose run ended (it may have pressed) gets a run again, and the node answers from its own record.
 */
export async function resumeQueuedOutbox(db: Db): Promise<number> {
  const rows = await db
    .select({
      id: outbox.id,
      payload: outbox.payload,
      stale: sql<boolean>`${outbox.createdAt} < now() - ${STALE_PRESS}::interval`,
    })
    .from(outbox)
    // Only bids: a message row (M4) has its own delivery and must never go down the bid path.
    .where(and(eq(outbox.state, 'queued'), eq(outbox.kind, 'bid')))
  let started = 0
  for (const r of rows) {
    const p = r.payload as BidPayload
    const legacy = await DBOS.getWorkflowStatus(legacyWorkflowIdOf(p.leadId))
    if (legacy && RUNNING.includes(legacy.status)) continue
    const own = await DBOS.getWorkflowStatus(workflowIdOf(r.id))
    if (!own && !legacy && r.stale) {
      await giveBack(r.id, p, 'stale')
      await tell(TEXTS.bidStale(p.title), p)
      if (p.taskId)
        await d()
          .resendCard(p.taskId)
          .catch(() => {})
      continue
    }
    await startOutboxDelivery(r.id)
    started++
  }
  return started
}

type Spent = { spent: number; balanceAfter: number | null; foundLater?: boolean }

/**
 * Marks the bid as sent exactly once; a repeat (for example a re-run step after a crash) returns false. An unsure
 * bid found on its order later (`foundLater`) is confirmed from its unsure state.
 */
export async function confirmBid(db: Db, outboxId: string, r: Spent): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(outbox)
      .set({ state: 'confirmed', confirmedAt: new Date().toISOString() })
      .where(and(eq(outbox.id, outboxId), eq(outbox.state, r.foundLater ? 'uncertain' : 'queued')))
      .returning({ payload: outbox.payload })
    const row = rows[0]
    if (!row) return false
    const p = row.payload as BidPayload
    const later = r.foundLater ? { found_later: true } : {}
    await appendEvent(tx, ev('outbox.confirmed', p, { kind: 'outbox', id: outboxId }))
    await appendEvent(
      tx,
      ev('bid.sent', p, { kind: 'lead', id: p.leadId }, { spent_rub: r.spent, ...later }),
    )
    await appendEvent(
      tx,
      ev(
        'spend.recorded',
        p,
        { kind: 'lead', id: p.leadId },
        { amount_rub: r.spent, balance_after_rub: r.balanceAfter, ...later },
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
): Promise<boolean> {
  return d().db.transaction(async (tx) => {
    const rows = await tx
      .update(outbox)
      .set({ state, errorClass })
      .where(and(eq(outbox.id, outboxId), eq(outbox.state, 'queued')))
      .returning({ id: outbox.id })
    if (rows.length === 0) return false
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
    return true
  })
}

/**
 * The order already had this account's bid (Boris bid by hand): nothing was spent, no deal is Sara's to run. The
 * row stays (failed), so the order is not pressed again.
 */
async function markAlreadyThere(outboxId: string, p: BidPayload): Promise<boolean> {
  const marked = await markNotSent(outboxId, p, 'failed', 'ALREADY_ON_PAGE')
  if (marked) await d().db.update(lead).set({ status: 'bid_sent' }).where(eq(lead.id, p.leadId))
  return marked
}

/**
 * Nothing was pressed: the row goes, so the same order can be pressed again (its next row gets its own run), the
 * task opens and the lead waits again (paused, refused by the node, or stale after a restart).
 */
async function giveBack(outboxId: string, p: BidPayload, reason: string): Promise<void> {
  await d().db.transaction(async (tx) => {
    const rows = await tx
      .delete(outbox)
      .where(and(eq(outbox.id, outboxId), eq(outbox.state, 'queued')))
      .returning({ id: outbox.id })
    if (rows.length === 0) return
    await appendEvent(
      tx,
      ev('bid.failed', p, { kind: 'lead', id: p.leadId }, { reason, given_back: true }, reason),
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

/**
 * The fee the order page asks now, read from the page itself (not the node's store), put on the lead so the card
 * Boris gets back shows it; null when unknown.
 */
async function freshFee(p: BidPayload): Promise<number | null> {
  try {
    const o = await d().profi.getOrder(p.accountId, p.leadId)
    if (o.from_page !== true || o.bid_price_rub <= 0) return null
    await d().db.update(lead).set({ bidPriceRub: o.bid_price_rub }).where(eq(lead.id, p.leadId))
    return o.bid_price_rub
  } catch {
    return null
  }
}

/** The order page, read now, says this account bid on it; any failure to read it is «not seen». */
async function bidOnOrder(p: BidPayload): Promise<boolean> {
  try {
    const o = await d().profi.getOrder(p.accountId, p.leadId)
    return o.from_page === true && o.has_bid === true
  } catch {
    return false
  }
}

type Attempt =
  | { kind: 'ok'; spent: number; balanceAfter: number | null; alreadyThere?: boolean }
  | { kind: 'uncertain' }
  /** Recorded before 25.10.2026: a refusal of the node, then final. */
  | { kind: 'failed'; errorClass: string }
  /** The node pressed nothing (any class but UNCERTAIN and RATE_LIMITED). */
  | { kind: 'refused'; errorClass: ProfiErrorClass }
  /** The account tab may not move now (RATE_LIMITED): nothing was pressed, it is tried again later. */
  | { kind: 'busy' }
  /** Bids were paused right before the call: the node was not called. */
  | { kind: 'paused' }

/** One call of the node. `mayBeOnSite`: an earlier call was unsure, so a pause now must not give the order back. */
async function attempt(
  row: typeof outbox.$inferSelect,
  p: BidPayload,
  n: number,
  mayBeOnSite: boolean,
): Promise<Attempt> {
  const [before] = await d()
    .db.select({ attempts: outbox.attempts })
    .from(outbox)
    .where(eq(outbox.id, row.id))
  // This step ran before (the core stopped in the middle of it): that call may have pressed.
  const ranBefore = (before?.attempts ?? 0) > n
  await d()
    .db.update(outbox)
    .set({ attempts: n + 1 })
    .where(eq(outbox.id, row.id))
  // The pause is read again right before the node is called: Boris may have set it while the bid waited.
  if (!(await getSetting(d().db, 'outbound.bids')))
    return mayBeOnSite || ranBefore ? { kind: 'uncertain' } : { kind: 'paused' }
  try {
    const r = await d().profi.submitBid({
      account_id: p.accountId,
      order_id: p.leadId,
      // Greeted and tidied at this very moment, not at the press: the hour may have changed since the card (rule 5).
      text: bidTextAt(p.text, p.clientName ?? '', d().now?.() ?? new Date()),
      price_rub: p.servicePriceRub ?? null,
      // The fee on the card Boris pressed: the node pays no more than that.
      max_fee_rub: p.priceRub,
      idempotency_key: row.idempotencyKey,
    })
    // The node saw this account's bid before this key pressed anything: Boris bid by hand.
    const alreadyThere = r.already_there === true
    return { kind: 'ok', spent: r.spent_rub, balanceAfter: r.balance_after_rub, alreadyThere }
  } catch (e) {
    if (e instanceof ProfiError && e.errorClass === 'RATE_LIMITED') return { kind: 'busy' }
    if (e instanceof ProfiError && e.errorClass !== 'UNCERTAIN')
      return { kind: 'refused', errorClass: e.errorClass }
    return { kind: 'uncertain' }
  }
}

/**
 * Steps of a bid that was not pressed: the order goes back to Boris with the reason. A dearer bid first reads the
 * new fee from the order page, so the card he gets shows it. A closed order, or a form asking more while the page
 * shows no higher fee (a press again would end the same), only says so: no card, the row stays failed.
 */
async function backToBoris(outboxId: string, p: BidPayload, reason: string): Promise<void> {
  const fee =
    reason === 'PRICE_CHANGED' ? await DBOS.runStep(() => freshFee(p), { name: 'freshFee' }) : null
  if (
    reason === 'ORDER_CLOSED' ||
    (reason === 'PRICE_CHANGED' && !(fee !== null && fee > p.priceRub))
  ) {
    await DBOS.runStep(() => markNotSent(outboxId, p, 'failed', reason), {
      name: 'markFailed',
      ...DB_STEP,
    })
    const text =
      reason === 'ORDER_CLOSED'
        ? TEXTS.bidRefused(p.title, reason)
        : TEXTS.bidDearer(p.title, p.priceRub, null)
    await DBOS.runStep(() => tell(text, p), { name: 'tellRefused' })
    // The card stays in the chat with its buttons: it is closed in place (a new step, behind a patch, so a run
    // recorded before it ends as it began).
    if (reason === 'ORDER_CLOSED' && p.taskId && (await DBOS.patch('close-card-on-order-closed'))) {
      const taskId = p.taskId
      await DBOS.runStep(
        () =>
          d()
            .closeCard(taskId)
            .catch(() => {}),
        { name: 'closeCard' },
      )
    }
    return
  }
  await DBOS.runStep(() => giveBack(outboxId, p, reason), { name: 'giveBack', ...DB_STEP })
  const text =
    reason === 'paused'
      ? TEXTS.bidsPaused
      : reason === 'PRICE_CHANGED'
        ? TEXTS.bidDearer(p.title, p.priceRub, fee)
        : TEXTS.bidRefused(p.title, reason)
  await DBOS.runStep(() => tell(text, p), {
    name: reason === 'paused' ? 'tellPaused' : 'tellRefused',
  })
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
}

/**
 * An unsure bid is looked for on its order page later (B4): the node presses nothing after the deadline it was
 * given, so once the bid shows, it is this press (or Boris's own after «Не знаю»). Its spend is the fee on the card,
 * the most the node may have paid.
 */
async function lookForUnsure(outboxId: string, p: BidPayload): Promise<void> {
  const waits = d().reconcileDelaysMs
  for (let k = 0; k < waits.length; k++) {
    await DBOS.sleep(waits[k] ?? 0)
    const seen = await DBOS.runStep(() => bidOnOrder(p), { name: `look-${k}` })
    if (!seen) continue
    const first = await DBOS.runStep(
      () =>
        confirmBid(d().db, outboxId, { spent: p.priceRub, balanceAfter: null, foundLater: true }),
      { name: 'confirmFound', ...DB_STEP },
    )
    if (first)
      await DBOS.runStep(() => tell(TEXTS.bidFoundLater(p.title, p.priceRub), p), {
        name: 'tellFound',
      })
    return
  }
}

/** Only a queued bid goes down the bid path; a message row (M4) has its own delivery. */
export function isBidRow(r: { kind: string; state: string }): boolean {
  return r.kind === 'bid' && r.state === 'queued'
}

async function deliver(outboxId: string): Promise<void> {
  const [row] = await DBOS.runStep(
    () => d().db.select().from(outbox).where(eq(outbox.id, outboxId)),
    { name: 'load', ...DB_STEP },
  )
  if (!row || !isBidRow(row)) return
  const p = row.payload as BidPayload

  const allowed = await DBOS.runStep(() => getSetting(d().db, 'outbound.bids'), {
    name: 'checkPause',
    ...DB_STEP,
  })
  if (!allowed) return backToBoris(outboxId, p, 'paused')

  // Steps keep their names and order: a run recorded before a change resumes along the steps it took.
  const delays = d().retryDelaysMs
  const busy = d().busyRetry
  let result: Attempt = { kind: 'uncertain' }
  let unsure = 0
  let waits = 0
  for (let i = 0; ; i++) {
    const n = i
    const mayBeOnSite = unsure > 0
    result = await DBOS.runStep(() => attempt(row, p, n, mayBeOnSite), { name: `submit-${n}` })
    if (result.kind === 'uncertain') {
      const delay = delays[unsure++]
      if (delay === undefined) break
      await DBOS.sleep(delay)
    } else if (result.kind === 'busy' && waits < busy.tries) {
      waits++
      await DBOS.sleep(busy.delayMs)
    } else break
  }

  // A refusal after an unsure call: that earlier call may still have pressed before its deadline, so it is unsure.
  const final: Attempt =
    unsure > 0 && (result.kind === 'refused' || result.kind === 'busy')
      ? { kind: 'uncertain' }
      : result
  if (final.kind === 'ok') {
    if (final.alreadyThere) {
      const first = await DBOS.runStep(() => markAlreadyThere(outboxId, p), {
        name: 'markAlready',
        ...DB_STEP,
      })
      if (first)
        await DBOS.runStep(() => tell(TEXTS.bidAlreadyThere(p.title), p), { name: 'tellAlready' })
      return
    }
    const first = await DBOS.runStep(() => confirmBid(d().db, outboxId, final), {
      name: 'confirm',
      ...DB_STEP,
    })
    // What was spent, not the fee on the card.
    if (first)
      await DBOS.runStep(() => tell(TEXTS.bidSent(p.title, final.spent), p), { name: 'tellSent' })
  } else if (final.kind === 'uncertain') {
    // The bid may be on the site: never say it failed, or Boris bids again by hand.
    await DBOS.runStep(() => markNotSent(outboxId, p, 'uncertain', 'UNCERTAIN'), {
      name: 'markUncertain',
      ...DB_STEP,
    })
    await DBOS.runStep(() => tell(TEXTS.bidUncertain, p), { name: 'tellUncertain' })
    await lookForUnsure(outboxId, p)
  } else if (final.kind === 'failed' && !(await DBOS.patch('bid-give-back'))) {
    // A run that recorded its failure before the give-back existed ends as it began.
    await DBOS.runStep(() => markNotSent(outboxId, p, 'failed', final.errorClass), {
      name: 'markFailed',
      ...DB_STEP,
    })
    await DBOS.runStep(() => tell(TEXTS.bidFailed, p), { name: 'tellFailed' })
  } else {
    const reason =
      final.kind === 'busy' ? 'RATE_LIMITED' : final.kind === 'paused' ? 'paused' : final.errorClass
    await backToBoris(outboxId, p, reason)
  }
}

const deliverWorkflow = DBOS.registerWorkflow(deliver, { name: 'deliverOutbox' })
