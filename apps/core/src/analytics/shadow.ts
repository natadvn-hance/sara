import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'

export type SeenStat = {
  count: number
  p90SeenMs: number | null
  p95SeenMs: number | null
  under60sShare: number
}

export type ShadowReport = {
  orders: SeenStat
  messages: SeenStat
  authorUnclear: number
  sessionDeaths: number
  connectionLosses: number
  layoutChanged: number
  lostEvents: number
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  return (
    sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))] ??
    null
  )
}

function stat(values: number[]): SeenStat {
  const s = [...values].sort((a, b) => a - b)
  return {
    count: s.length,
    p90SeenMs: percentile(s, 90),
    p95SeenMs: percentile(s, 95),
    under60sShare: s.length === 0 ? 0 : s.filter((v) => v < 60_000).length / s.length,
  }
}

async function count(db: DbOrTx, type: string, from: string, to: string): Promise<number> {
  const r = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from core.event where type = ${type} and recorded_at >= ${from} and recorded_at < ${to}`,
  )
  return r.rows[0]?.n ?? 0
}

/**
 * The 48-hour shadow (ST-M1-11, SLO-3): how long after the site an order and a message reached the core, and
 * what got lost. Runs on the server, where it may read schema node next to the journal (an analysis, not the
 * core's own work).
 */
export async function shadowReport(db: DbOrTx, from: string, to: string): Promise<ShadowReport> {
  const orders = await db.execute<{ ms: number }>(sql`
    select extract(epoch from (e.recorded_at - (o.body->>'published_at')::timestamptz)) * 1000 as ms
    from core.event e
    join node.raw_order o on o.order_id = e.entity_id
    where e.type = 'profi.order_seen' and e.recorded_at >= ${from} and e.recorded_at < ${to}
      and o.body->>'published_at' is not null`)
  const messages = await db.execute<{ ms: number }>(sql`
    select extract(epoch from (e.recorded_at - (e.payload->>'sent_at')::timestamptz)) * 1000 as ms
    from core.event e
    where e.type = 'profi.client_message' and e.recorded_at >= ${from} and e.recorded_at < ${to}`)
  const lost = await db.execute<{ n: number }>(sql`
    select
      (select count(*) from node.raw_order o where o.seen_at >= ${from} and o.seen_at < ${to}
         and not exists (select 1 from core.event e where e.type = 'profi.order_seen' and e.entity_id = o.order_id))
    + (select count(*) from node.raw_message m where m.sent_at >= ${from} and m.sent_at < ${to}
         and m.author in ('client', 'unknown') and not m.history
         and not exists (select 1 from core.event e
           where e.type in ('profi.client_message', 'profi.author_unclear')
             and e.payload->>'platform_message_id' = m.platform_message_id))
    as n`)
  return {
    orders: stat(orders.rows.map((r) => Number(r.ms))),
    messages: stat(messages.rows.map((r) => Number(r.ms))),
    authorUnclear: await count(db, 'profi.author_unclear', from, to),
    sessionDeaths: await count(db, 'profi.session_dead', from, to),
    connectionLosses: await count(db, 'profi.connection_lost', from, to),
    layoutChanged: await count(db, 'profi.layout_changed', from, to),
    lostEvents: Number(lost.rows[0]?.n ?? 0),
  }
}

const sec = (ms: number | null) =>
  ms === null ? 'нет данных' : `${(ms / 1000).toFixed(1).replace('.', ',')} с`
const share = (x: number) => `${Math.round(x * 100)}%`
const msk = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

/** One message for Boris: the shadow's numbers against the M1 targets, in plain words. */
export function formatShadowReport(r: ShadowReport, from: string, to: string): string {
  const ok = (good: boolean) => (good ? '✅' : '⚠️')
  return [
    `Тень новой Сары с ${msk(from)} по ${msk(to)}`,
    `${ok(r.orders.count > 0 && r.orders.under60sShare >= 0.9)} Заявки: ${r.orders.count}, быстрее минуты ${share(r.orders.under60sShare)} (цель 90%), 90% быстрее ${sec(r.orders.p90SeenMs)}`,
    `${ok(r.messages.count > 0 && r.messages.under60sShare >= 0.95)} Сообщения клиентов: ${r.messages.count}, быстрее минуты ${share(r.messages.under60sShare)} (цель 95%)`,
    `${ok(r.lostEvents === 0)} Потеряно: ${r.lostEvents}`,
    `${ok(r.authorUnclear === 0)} Автор неясен: ${r.authorUnclear}`,
    `Разлогинов: ${r.sessionDeaths}, пропаданий связи: ${r.connectionLosses}, «сайт поменялся»: ${r.layoutChanged}`,
  ].join('\n')
}
