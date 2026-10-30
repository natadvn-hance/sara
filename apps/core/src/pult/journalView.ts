import type { EntityRef, JournalRow, JournalView, TraceView } from '@sara/shared'
import { and, asc, desc, eq, inArray, lt, type SQL, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { event, lead, modelCall } from '../db/schema'
import { clientNames, describeEvents } from './feed'

/**
 * «Журнал» and the trace (FR-OPS-4, pult v2 design 9): Sara's steps from the journal in her words where the feed
 * knows them, the type itself otherwise; never a client's text. The trace is one chain with its model calls.
 */

const PAGE = 50
type Row = typeof event.$inferSelect

async function rowsOf(db: DbOrTx, rows: Row[]): Promise<JournalRow[]> {
  const said = await describeEvents(db, rows)
  const leadIds = [...new Set(rows.filter((r) => r.entityKind === 'lead').map((r) => r.entityId))]
  const titles = new Map(
    (leadIds.length
      ? await db
          .select({ id: lead.id, title: lead.title })
          .from(lead)
          .where(inArray(lead.id, leadIds))
      : []
    ).map((l) => [l.id, l.title]),
  )
  const names = await clientNames(
    db,
    rows.filter((r) => r.entityKind === 'conversation').map((r) => r.entityId),
  )
  const entityOf = (r: Row): EntityRef | null => {
    if (r.entityKind === 'lead')
      return {
        kind: 'lead',
        id: r.entityId,
        title: titles.get(r.entityId) ?? `заказ ${r.entityId}`,
      }
    if (r.entityKind === 'conversation')
      return { kind: 'client', id: r.entityId, title: names.get(r.entityId) ?? 'клиент' }
    if (r.entityKind === 'setting') return { kind: 'setting', id: r.entityId, title: r.entityId }
    if (r.entityKind === 'mind_record') return { kind: 'mind', id: r.entityId, title: r.entityId }
    return null
  }
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    text: said.get(r.id)?.text ?? r.type,
    at: r.occurredAt,
    actor: r.actor,
    entity: entityOf(r),
    reason: r.reason,
    correlationId: r.correlationId,
  }))
}

export async function journalView(
  db: DbOrTx,
  f: { type?: string; kind?: string; id?: string; before?: string } = {},
): Promise<JournalView> {
  const conds: SQL[] = []
  if (f.type) conds.push(eq(event.type, f.type))
  if (f.kind) conds.push(eq(event.entityKind, f.kind))
  if (f.id) conds.push(eq(event.entityId, f.id))
  if (f.before) conds.push(lt(event.occurredAt, f.before))
  const rows = await db
    .select()
    .from(event)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(event.occurredAt), desc(event.id))
    .limit(PAGE + 1)
  const page = rows.slice(0, PAGE)
  const types = await db
    .select({ type: event.type })
    .from(event)
    .where(sql`${event.occurredAt} > now() - interval '30 days'`)
    .groupBy(event.type)
    .orderBy(event.type)
  return {
    items: await rowsOf(db, page),
    next: rows.length > PAGE ? (page.at(-1)?.occurredAt ?? null) : null,
    types: types.map((t) => t.type),
  }
}

export async function traceView(db: DbOrTx, correlationId: string): Promise<TraceView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(correlationId)) return null
  const rows = await db
    .select()
    .from(event)
    .where(eq(event.correlationId, correlationId))
    .orderBy(asc(event.occurredAt), asc(event.id))
  if (rows.length === 0) return null
  const events = await rowsOf(db, rows)
  // The model calls of the chain: the journal names them (`model.called`), the table has the figures.
  const callIds = rows
    .filter((r) => r.entityKind === 'model_call')
    .map((r) => r.entityId)
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const calls = callIds.length
    ? await db
        .select()
        .from(modelCall)
        .where(inArray(modelCall.id, [...new Set(callIds)]))
        .orderBy(asc(modelCall.startedAt))
    : []
  const first = events.find((e) => e.entity?.kind === 'lead' || e.entity?.kind === 'client')
  return {
    correlationId,
    entity: first?.entity ?? null,
    events,
    calls: calls.map((c) => ({
      id: c.id,
      role: c.role,
      model: c.model,
      ok: c.ok,
      ms: c.durationMs,
      at: c.startedAt,
      errorClass: c.errorClass,
    })),
  }
}
