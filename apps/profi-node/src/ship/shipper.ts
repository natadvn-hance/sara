import { and, asc, count, isNotNull, isNull, min, sql } from 'drizzle-orm'
import type { NodeDb } from '../db/client'
import { outboxNode } from '../db/schema'

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 15000, 60000, 300000]

export type Shipper = { start(): void; stop(): Promise<void>; flush(): Promise<number> }

/** Delivers queued events to the core (C8) in order until each is confirmed (ADR-019). */
export function createShipper(o: {
  db: NodeDb
  coreEventsUrl: string
  nodeToken: string
  backoffMs?: number[]
  pollMs?: number
}): Shipper {
  const backoff = o.backoffMs ?? DEFAULT_BACKOFF_MS
  let timer: NodeJS.Timeout | null = null
  let running: Promise<number> | null = null

  const delayFor = (attempts: number) => backoff[Math.min(attempts, backoff.length - 1)] ?? 300000

  async function flushOnce(): Promise<number> {
    const due = await o.db
      .select({
        eventId: outboxNode.eventId,
        payload: outboxNode.payload,
        attempts: outboxNode.attempts,
        isDue: sql<boolean>`${outboxNode.nextTryAt} <= now()`,
      })
      .from(outboxNode)
      .where(and(isNull(outboxNode.confirmedAt), isNull(outboxNode.deadReason)))
      .orderBy(asc(outboxNode.eventId))
      .limit(100)
    let sent = 0
    for (const row of due) {
      // The oldest unsent event goes first; while it waits for its retry, the ones after it wait too.
      if (!row.isDue) break
      let status = 0
      try {
        const res = await fetch(o.coreEventsUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sara-node-token': o.nodeToken },
          body: JSON.stringify(row.payload),
          signal: AbortSignal.timeout(15000),
        })
        status = res.status
      } catch {
        status = 0
      }
      const where = sql`${outboxNode.eventId} = ${row.eventId}`
      if (status >= 200 && status < 300) {
        await o.db.update(outboxNode).set({ confirmedAt: new Date().toISOString() }).where(where)
        sent++
        continue
      }
      // 400: the event breaks the contract and never passes. 401 is a wrong token: a setting to fix, so retry.
      if (status === 400) {
        await o.db
          .update(outboxNode)
          .set({ deadReason: `core answered ${status}`, attempts: row.attempts + 1 })
          .where(where)
        continue
      }
      // The database clock decides when a row is due, so Node's and Postgres' clocks never disagree.
      const delay = delayFor(row.attempts)
      await o.db
        .update(outboxNode)
        .set({
          attempts: row.attempts + 1,
          nextTryAt: sql`now() + ${delay} * interval '1 millisecond'`,
        })
        .where(where)
      // Keep the order: later events wait until this one is through.
      break
    }
    return sent
  }

  async function flush(): Promise<number> {
    while (running) await running
    running = flushOnce()
    try {
      return await running
    } finally {
      running = null
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void flush().catch(() => {}), o.pollMs ?? 500)
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      while (running) await running
    },
    flush,
  }
}

export async function shipperHealth(
  db: NodeDb,
): Promise<{ queued: number; oldestQueuedAt: string | null; dead: number }> {
  const [q] = await db
    .select({ n: count(), oldest: min(sql<string>`${outboxNode.payload}->>'occurred_at'`) })
    .from(outboxNode)
    .where(and(isNull(outboxNode.confirmedAt), isNull(outboxNode.deadReason)))
  const [d] = await db
    .select({ n: count() })
    .from(outboxNode)
    .where(isNotNull(outboxNode.deadReason))
  return { queued: q?.n ?? 0, oldestQueuedAt: q?.oldest ?? null, dead: d?.n ?? 0 }
}
