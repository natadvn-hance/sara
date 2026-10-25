import {
  type Actor,
  type Channel,
  type EventType,
  type MeetingKind,
  type MeetingState,
  newEventId,
} from '@sara/shared'
import { and, eq, or, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db/client'
import { deal, lead, meeting } from '../db/schema'
import { appendEvent } from '../journal/journal'

/** Allowed moves of a meeting (design 5.8); `done` and `no_show` swap only when Boris corrects himself. */
export const MEETING_MOVES: Record<MeetingState, readonly MeetingState[]> = {
  offered: ['confirming', 'withdrawn', 'expired'],
  confirming: ['booked', 'offered', 'withdrawn'],
  booked: ['done', 'no_show', 'moved', 'cancelled'],
  done: ['no_show'],
  no_show: ['done'],
  moved: [],
  cancelled: [],
  withdrawn: [],
  expired: [],
}

const EVENT_OF: Record<MeetingState, EventType> = {
  offered: 'meeting.unconfirmed',
  confirming: 'meeting.confirming',
  booked: 'meeting.booked',
  done: 'meeting.held',
  no_show: 'meeting.no_show',
  moved: 'meeting.moved',
  cancelled: 'meeting.cancelled',
  withdrawn: 'meeting.withdrawn',
  expired: 'meeting.expired',
}

/** A client's phone and words about the meeting live 30 days after it (spec 8.3). */
const PURGE_MS = 30 * 24 * 3600_000
const ENDED: readonly MeetingState[] = ['moved', 'cancelled', 'withdrawn', 'expired']

export type MeetingRow = typeof meeting.$inferSelect
export type MeetingPatch = Omit<
  Partial<typeof meeting.$inferInsert>,
  'id' | 'dealId' | 'state' | 'createdAt'
>

export class MeetingMoveError extends Error {
  constructor(
    readonly from: string,
    readonly to: MeetingState,
  ) {
    super(`meeting ${from} -> ${to} is not allowed`)
  }
}

const purgeAt = (from: string | null) =>
  new Date((from ? new Date(from).getTime() : Date.now()) + PURGE_MS).toISOString()

async function journal(
  tx: Tx,
  type: EventType,
  m: { id: string; accountId: string; dealId: string },
  actor: Actor,
  payload: Record<string, unknown>,
  correlationId: string,
) {
  await appendEvent(tx, {
    type,
    v: 1,
    entity: { kind: 'meeting', id: m.id },
    account_id: m.accountId,
    actor,
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: correlationId,
    reason: null,
    payload: { deal_id: m.dealId, ...payload },
  })
}

/** Writes a new meeting, offered by the procedure or booked (Boris's mark, a call now), with its event. */
export async function createMeeting(
  tx: Tx,
  m: {
    dealId: string
    conversationId: string | null
    accountId: string
    kind: MeetingKind
    state: 'offered' | 'booked'
    startsAt: string | null
    durationMin: number
    channel: Channel | null
    offered: string[] | null
    roundKey: string | null
    createdBy: 'sara' | 'boris'
    movedFrom?: string
    phone?: string | null
    correlationId?: string
  },
): Promise<string> {
  const id = newEventId()
  const now = new Date().toISOString()
  const phone = m.phone ?? null
  await tx.insert(meeting).values({
    id,
    dealId: m.dealId,
    conversationId: m.conversationId,
    accountId: m.accountId,
    kind: m.kind,
    state: m.state,
    startsAt: m.startsAt,
    durationMin: m.durationMin,
    channel: m.channel,
    offered: m.offered?.map((s) => ({ starts_at: s })) ?? null,
    roundKey: m.roundKey,
    movedFrom: m.movedFrom ?? null,
    phone,
    phonePurgeAt: phone ? purgeAt(m.startsAt) : null,
    bookedAt: m.state === 'booked' ? now : null,
    createdBy: m.createdBy,
  })
  await journal(
    tx,
    m.state === 'offered' ? 'meeting.offered' : 'meeting.booked',
    { id, accountId: m.accountId, dealId: m.dealId },
    m.createdBy,
    {
      kind: m.kind,
      state: m.state,
      starts_at: m.startsAt,
      offered: m.offered?.length ?? 0,
      channel: m.channel,
      moved_from: m.movedFrom ?? null,
    },
    m.correlationId ?? newEventId(),
  )
  return id
}

/** The only way a meeting changes state: checked against MEETING_MOVES, written and journaled. */
export async function moveMeeting(
  tx: Tx,
  id: string,
  to: MeetingState,
  patch: MeetingPatch,
  actor: Actor,
  correlationId: string = newEventId(),
): Promise<MeetingRow> {
  const [row] = await tx.select().from(meeting).where(eq(meeting.id, id)).for('update')
  if (!row) throw new Error(`meeting ${id} not found`)
  const from = row.state as MeetingState
  if (!MEETING_MOVES[from].includes(to)) throw new MeetingMoveError(from, to)
  const now = new Date().toISOString()
  const set: Partial<typeof meeting.$inferInsert> = { ...patch, state: to, updatedAt: now }
  if (to === 'booked' && !row.bookedAt) set.bookedAt = now
  if (ENDED.includes(to) && row.phone) set.phonePurgeAt = purgeAt(null)
  const [updated] = await tx.update(meeting).set(set).where(eq(meeting.id, id)).returning()
  await journal(
    tx,
    EVENT_OF[to],
    { id, accountId: row.accountId, dealId: row.dealId },
    actor,
    {
      from,
      to,
      starts_at: updated?.startsAt ?? null,
      clock_version: updated?.clockVersion ?? row.clockVersion,
    },
    correlationId,
  )
  return updated as MeetingRow
}

/**
 * The deal of a client's order: the one made by the new Sara's bid (found by order or lead), or a new one for old
 * Sara's client (origin v1, at talking), so a meeting and its outcome always have a home (design 6.1).
 */
export async function ensureDeal(
  db: Db,
  i: { accountId: string; orderId: string; actor: Actor; correlationId?: string },
): Promise<{ dealId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`deal:${i.accountId}:${i.orderId}`}))`,
    )
    const [found] = await tx
      .select({ id: deal.id })
      .from(deal)
      .where(
        and(
          eq(deal.accountId, i.accountId),
          or(eq(deal.orderId, i.orderId), eq(deal.leadId, i.orderId)),
        ),
      )
      .limit(1)
    if (found) return { dealId: found.id, created: false }
    const [known] = await tx.select({ id: lead.id }).from(lead).where(eq(lead.id, i.orderId))
    const id = newEventId()
    await tx.insert(deal).values({
      id,
      leadId: known ? known.id : null,
      orderId: i.orderId,
      origin: 'v1',
      accountId: i.accountId,
      stage: 'talking',
    })
    await appendEvent(tx, {
      type: 'deal.stage_changed',
      v: 1,
      entity: { kind: 'deal', id },
      account_id: i.accountId,
      actor: i.actor,
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: i.correlationId ?? newEventId(),
      reason: null,
      payload: { from: null, to: 'talking', origin: 'v1' },
    })
    return { dealId: id, created: true }
  })
}
