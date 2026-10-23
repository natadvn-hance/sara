import { and, asc, count, isNotNull, isNull, lte, min, sql } from 'drizzle-orm'
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
      .select()
      .from(outboxNode)
      .where(
        and(
          isNull(outboxNode.confirmedAt),
          isNull(outboxNode.deadReason),
          lte(outboxNode.nextTryAt, sql`now()`),
        ),
      )
      .orderBy(asc(outboxNode.eventId))
      .limit(100)
    let sent = 0
    for (const row of due) {
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
      if (status === 400 || status === 401) {
        await o.db
          .update(outboxNode)
          .set({ deadReason: `core answered ${status}`, attempts: row.attempts + 1 })
          .where(where)
        continue
      }
      const next = new Date(Date.now() + delayFor(row.attempts)).toISOString()
      await o.db
        .update(outboxNode)
        .set({ attempts: row.attempts + 1, nextTryAt: next })
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
