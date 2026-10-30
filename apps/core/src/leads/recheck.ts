import { type GetOrderOutput, newEventId } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { appendEvent } from '../journal/journal'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { type ProfiClient, ProfiError } from '../profi/client'
import { mskHour } from './cardFlow'

/**
 * A waiting card is looked at again when its last look is older than this, by the age of its order (Boris, 30.10.2026:
 * he must not press «Откликнуться» on a closed order): a fresh one closes soonest.
 */
const LOOK_EVERY_MS = { fresh: 15 * 60_000, day: 3600_000, older: 3 * 3600_000 }
/** An order seen this recently is fresh. */
const FRESH_MS = 3 * 3600_000
const DAY_MS = 24 * 3600_000
/** An order gone from the feed has its page read at once, unless it was read this recently. */
const GONE_GAP_MS = 2 * 60_000
/** Pages are read from this Moscow hour (inclusive) up to the other (exclusive): never at night. */
const FROM_HOUR = 9
const TO_HOUR = 23
/** Boris is warned about a changed order page at most this often. */
const DOUBT_EVERY_MS = 24 * 3600_000
/** Fewer checked cards than this cannot tell a changed page from a few closed orders. */
const DOUBT_MIN_CHECKED = 3
/** The reads of fresh orders' pages a doubt looks at: the latest ones, none older than this. */
const DOUBT_FRESH_READS = 3
const DOUBT_FRESH_WITHIN_MS = 2 * 3600_000

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
  /** An order left the feed (profi.order_gone): a pass now, or right after the one going on. */
  kick(): void
}

type Due = {
  task_id: string
  order_id: string
  account_id: string
  correlation_id: string
}

const ago = (at: Date, ms: number) => new Date(at.getTime() - ms).toISOString()

/**
 * FR-LEAD-5: a card that waits for Boris's decision may outlive its order: the client closes it, and the card still
 * says «Откликнуться». Every `tickMs` (5 minutes) the waiting cards whose look is due have their order page read again
 * through the node, a few at a time, never at night: a fresh order's every 15 minutes, a day-old one's every hour,
 * an older one's every 3 hours, and at once an order gone from the feed. A closed order's card goes to `close`.
 * When most of a pass looks closed and the latest pages of fresh orders look closed too, the site more likely
 * changed than the clients: nothing is closed, Boris is told (once a day). Old orders closing together are no doubt
 * (27.10.2026). It only reads and journals; the tasks are `close`'s to end.
 */
export function startCardRecheck(d: {
  db: Db
  profi: Pick<ProfiClient, 'getOrder'>
  notifier: Pick<Notifier, 'sendText'>
  /** Closes the card of this task (its order is closed on Profi.ru). */
  close(taskId: string): Promise<void>
  now?: () => Date
  tickMs?: number
  /** How many pages one pass reads at most (default 3). */
  perPass?: number
}): CardRecheck {
  const now = d.now ?? (() => new Date())
  const perPass = d.perPass ?? 3

  /**
   * Open decision tasks whose card went out and whose look is due: gone from the feed first, then the most overdue.
   * The last look is the later of the card going out and the last read of its page.
   */
  async function due(at: Date): Promise<Due[]> {
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
      left join lateral (
        select max(e.occurred_at) as at from core.event e
        where e.type = 'profi.order_gone' and e.entity_kind = 'order' and e.entity_id = t.entity_id
      ) g on true
      cross join lateral (
        select greatest(coalesce(s.at, t.created_at), r.at) as at
      ) look
      cross join lateral (
        select case
          when l.seen_at > ${ago(at, FRESH_MS)}::timestamptz then ${ago(at, LOOK_EVERY_MS.fresh)}::timestamptz
          when l.seen_at > ${ago(at, DAY_MS)}::timestamptz then ${ago(at, LOOK_EVERY_MS.day)}::timestamptz
          else ${ago(at, LOOK_EVERY_MS.older)}::timestamptz
        end as before
      ) k
      cross join lateral (
        select coalesce(g.at > look.at, false) and look.at < ${ago(at, GONE_GAP_MS)}::timestamptz as gone
      ) x
      where t.kind = 'lead_decision' and t.state = 'open' and t.entity_kind = 'lead'
        and (s.at is not null or t.telegram_message_id is not null)
        and (look.at < k.before or x.gone)
      order by x.gone desc, look.at - k.before, t.created_at, t.id
      limit ${perPass}`)
    return rows.rows
  }

  /**
   * The site changed rather than the clients: the latest reads of fresh orders' pages (by any reader: a new order's
   * first read, a recheck, a press), within two hours, are at least two and none shows an open order.
   */
  async function freshPagesLookShut(at: Date): Promise<boolean> {
    const rows = await d.db.execute<{ open: boolean | null }>(sql`
      select (e.payload->>'open')::boolean as open
      from core.event e
      join core.lead l on l.id = e.entity_id
      where e.type = 'lead.page_read' and e.entity_kind = 'lead'
        and e.payload->>'ok' = 'true' and coalesce(e.payload->>'has_bid', '') <> 'true'
        and e.occurred_at > ${ago(at, DOUBT_FRESH_WITHIN_MS)}::timestamptz
        and e.occurred_at <= ${at.toISOString()}::timestamptz
        and e.occurred_at < l.seen_at + ${`${FRESH_MS / 1000} seconds`}::interval
      order by e.occurred_at desc, e.id desc
      limit ${DOUBT_FRESH_READS}`)
    return rows.rows.length >= 2 && rows.rows.every((r) => r.open === false)
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
    if (
      looks.length >= DOUBT_MIN_CHECKED &&
      shut.length * 2 > looks.length &&
      (await freshPagesLookShut(at))
    ) {
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

  // One pass at a time: a slow read never overlaps the next tick. A kick during a pass gets one more pass after it.
  let running: Promise<RecheckResult> | null = null
  let again = false
  const failed = (err: unknown) => console.error('card recheck failed', errText(err))
  function tick(at?: Date): Promise<RecheckResult> {
    if (running) return running
    running = pass(at ?? now()).finally(() => {
      running = null
      if (again) {
        again = false
        void tick().catch(failed)
      }
    })
    return running
  }
  function kick() {
    if (running) again = true
    else void tick().catch(failed)
  }
  const timer = setInterval(() => void tick().catch(failed), d.tickMs ?? 5 * 60_000)
  return { stop: () => clearInterval(timer), tick, kick }
}

const errText = (err: unknown) => (err instanceof Error ? err.message.slice(0, 200) : String(err))
