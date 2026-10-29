import { type GetOrderOutput, newEventId } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { appendEvent } from '../journal/journal'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { type ProfiClient, ProfiError } from '../profi/client'
import { mskHour } from './cardFlow'

/** A waiting card is looked at again when its last look is older than this. */
const LOOK_EVERY_MS = 3600_000
/** Pages are read from this Moscow hour (inclusive) up to the other (exclusive): never at night. */
const FROM_HOUR = 9
const TO_HOUR = 23
/** Boris is warned about a changed order page at most this often. */
const DOUBT_EVERY_MS = 24 * 3600_000
/** Fewer checked cards than this cannot tell a changed page from a few closed orders. */
const DOUBT_MIN_CHECKED = 3

export type RecheckResult = {
  /** Pages read in this pass. */
  checked: number
  /** Cards handed to close(): none when the pass doubted the page. */
  closed: number
  /** Most of the checked cards looked closed: none was closed. */
  doubt: boolean
}

export type CardRecheck = {
  stop(): void
  /** One pass at `at` (default: now); a pass already going on is not started a second time. */
  tick(at?: Date): Promise<RecheckResult>
}

type Due = {
  task_id: string
  order_id: string
  account_id: string
  correlation_id: string
}

/**
 * FR-LEAD-5: a card that waits for Boris's decision may outlive its order: the client closes it, and the card still
 * says «Откликнуться». Every `tickMs` (10 minutes) the oldest waiting cards, not looked at for an hour, have their
 * order page read again through the node, a few at a time, never at night. A closed order's card goes to `close`.
 * When most of a pass looks closed, the site more likely changed than the clients: nothing is closed, Boris is told
 * (once a day). It only reads and journals; the tasks are `close`'s to end.
 */
export function startCardRecheck(d: {
  db: Db
  profi: Pick<ProfiClient, 'getOrder'>
  notifier: Pick<Notifier, 'sendText'>
  /** Closes the card of this task (its order is closed on Profi.ru). */
  close(taskId: string): Promise<void>
  now?: () => Date
  tickMs?: number
  /** How many pages one pass reads at most (default 4). */
  perPass?: number
}): CardRecheck {
  const now = d.now ?? (() => new Date())
  const perPass = d.perPass ?? 4

  /** Open decision tasks whose card went out and whose last look is older than an hour, oldest look first. */
  async function due(at: Date): Promise<Due[]> {
    const limit = new Date(at.getTime() - LOOK_EVERY_MS).toISOString()
    const rows = await d.db.execute<Due>(sql`
      select t.id as task_id, t.entity_id as order_id, l.account_id, l.correlation_id
      from core.task t
      join core.lead l on l.id = t.entity_id
      left join lateral (
        select min(e.occurred_at) as at from core.event e
        where e.type = 'card.sent' and e.entity_kind = 'task' and e.entity_id = t.id::text
      ) s on true
      left join lateral (
        select max(e.occurred_at) as at from core.event e
        where e.type = 'lead.page_read' and e.entity_kind = 'lead' and e.entity_id = t.entity_id
      ) r on true
      where t.kind = 'lead_decision' and t.state = 'open' and t.entity_kind = 'lead'
        and (s.at is not null or t.telegram_message_id is not null)
        and greatest(coalesce(s.at, t.created_at), r.at) < ${limit}::timestamptz
      order by greatest(coalesce(s.at, t.created_at), r.at), t.created_at, t.id
      limit ${perPass}`)
    return rows.rows
  }

  /** The look goes into the journal as numbers and flags, never as the client's words (ADR-016). */
  async function journalRead(c: Due, at: Date, page: GetOrderOutput | { error: string }) {
    const payload =
      'error' in page
        ? {
            ok: false,
            open: null,
            has_bid: null,
            fee_rub: null,
            client_info: false,
            error: page.error,
            via: 'recheck',
          }
        : {
            ok: true,
            open: page.open,
            has_bid: page.has_bid,
            fee_rub: page.bid_price_rub > 0 ? page.bid_price_rub : null,
            client_info: page.client_info != null,
            error: null,
            via: 'recheck',
          }
    await appendEvent(d.db, {
      type: 'lead.page_read',
      v: 1,
      entity: { kind: 'lead', id: c.order_id },
      account_id: c.account_id,
      actor: 'sara',
      occurred_at: at.toISOString(),
      causation_id: null,
      correlation_id: c.correlation_id,
      reason: null,
      payload,
    }).catch((err) => console.error('recheck read not journaled', c.order_id, errText(err)))
  }

  /** Boris is told that the order page may have changed, unless he was in the last 24 hours. */
  async function warn(at: Date, closed: number, checked: number) {
    const recent = await d.db.execute(sql`
      select 1 from core.event
      where type = 'lead.recheck_doubt'
        and occurred_at > ${new Date(at.getTime() - DOUBT_EVERY_MS).toISOString()}::timestamptz
      limit 1`)
    if (recent.rows.length > 0) return
    try {
      await d.notifier.sendText(TEXTS.recheckDoubt(closed, checked), { place: 'leads' })
    } catch (err) {
      // Not written down: the next pass tries again.
      console.error('recheck warning not sent', errText(err))
      return
    }
    await appendEvent(d.db, {
      type: 'lead.recheck_doubt',
      v: 1,
      entity: { kind: 'system', id: 'card_recheck' },
      account_id: null,
      actor: 'sara',
      occurred_at: at.toISOString(),
      causation_id: null,
      correlation_id: newEventId(),
      reason: null,
      payload: { closed, checked },
    })
  }

  async function pass(at: Date): Promise<RecheckResult> {
    const hour = mskHour(at)
    if (hour < FROM_HOUR || hour >= TO_HOUR) return { checked: 0, closed: 0, doubt: false }
    const looks: { taskId: string; shut: boolean }[] = []
    for (const c of await due(at)) {
      let page: GetOrderOutput
      try {
        page = await d.profi.getOrder(c.account_id, c.order_id)
      } catch (err) {
        // The tab is busy, the session is dead, the line is down: the rest would fail the same way.
        const error = err instanceof ProfiError ? err.errorClass : 'INTERNAL'
        console.error('recheck page not read', c.order_id, error)
        await journalRead(c, at, { error })
        break
      }
      // An answer the node gave from its store is no read: it would pass a closed order as open.
      if (page.from_page !== true) {
        await journalRead(c, at, { error: 'NOT_READ' })
        break
      }
      await journalRead(c, at, page)
      // A bid of ours keeps an order from being «closed»: such an order may show no form either.
      looks.push({ taskId: c.task_id, shut: page.open === false && page.has_bid !== true })
    }
    const shut = looks.filter((l) => l.shut)
    if (looks.length >= DOUBT_MIN_CHECKED && shut.length * 2 > looks.length) {
      await warn(at, shut.length, looks.length)
      return { checked: looks.length, closed: 0, doubt: true }
    }
    for (const l of shut) {
      try {
        await d.close(l.taskId)
      } catch (err) {
        console.error('card not closed', l.taskId, errText(err))
      }
    }
    return { checked: looks.length, closed: shut.length, doubt: false }
  }

  // One pass at a time: a slow read never overlaps the next tick.
  let running: Promise<RecheckResult> | null = null
  function tick(at?: Date): Promise<RecheckResult> {
    if (running) return running
    running = pass(at ?? now()).finally(() => {
      running = null
    })
    return running
  }
  const timer = setInterval(
    () => void tick().catch((err) => console.error('card recheck failed', errText(err))),
    d.tickMs ?? 10 * 60_000,
  )
  return { stop: () => clearInterval(timer), tick }
}

const errText = (err: unknown) => (err instanceof Error ? err.message.slice(0, 200) : String(err))
