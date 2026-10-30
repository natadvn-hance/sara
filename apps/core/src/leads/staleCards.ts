import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'

/** An order and its card older than this are no longer offered (FR-LEAD-10). */
const STALE_MS = 24 * 3600_000

export type StaleSweep = {
  stop(): void
  /** One pass at `at` (default: now): how many cards went stale; a pass already going on is not started twice. */
  tick(at?: Date): Promise<{ closed: number }>
}

/**
 * FR-LEAD-10: an order older than a day is not offered, and neither is a card that waited a day for Boris (30.10.2026:
 * 153 decisions were open, 45 of them older than three days, in the bot and in the pult alike). Every `tickMs`
 * (5 minutes) the oldest of them, `perPass` at most, are handed to `close` (the pipeline's `closeStale`), which ends the
 * task and turns every message of the card into the short stale card. An edit in Telegram makes no sound, so a backlog
 * goes quietly, a pass at a time, at any hour.
 */
export function startStaleSweep(d: {
  db: Db
  close(taskId: string, at: Date): Promise<boolean>
  now?: () => Date
  tickMs?: number
  /** How many cards one pass ends at most (default 15). */
  perPass?: number
}): StaleSweep {
  const now = d.now ?? (() => new Date())
  const perPass = d.perPass ?? 15

  async function pass(at: Date) {
    const before = new Date(at.getTime() - STALE_MS).toISOString()
    const rows = await d.db.execute<{ id: string }>(sql`
      select t.id
      from core.task t
      join core.lead l on l.id = t.entity_id
      where t.kind = 'lead_decision' and t.state = 'open' and t.entity_kind = 'lead'
        and l.seen_at < ${before}::timestamptz and t.created_at < ${before}::timestamptz
      order by l.seen_at, t.id
      limit ${perPass}`)
    let closed = 0
    for (const r of rows.rows) {
      try {
        if (await d.close(r.id, at)) closed++
      } catch (err) {
        console.error(
          'stale card not closed',
          r.id,
          err instanceof Error ? err.message.slice(0, 200) : err,
        )
      }
    }
    return { closed }
  }

  let running: Promise<{ closed: number }> | null = null
  function tick(at?: Date) {
    if (running) return running
    running = pass(at ?? now()).finally(() => {
      running = null
    })
    return running
  }
  const timer = setInterval(
    () =>
      void tick().catch((err) =>
        console.error('stale sweep failed', err instanceof Error ? err.message.slice(0, 200) : err),
      ),
    d.tickMs ?? 5 * 60_000,
  )
  return { stop: () => clearInterval(timer), tick }
}
