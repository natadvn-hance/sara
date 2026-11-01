import {
  type ClientList,
  type ClientRow,
  type ClientView,
  type FunnelStage,
  type MeetingList,
  type MeetingRow,
  newEventId,
} from '@sara/shared'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { conversation, deal, meeting } from '../db/schema'
import { TransitionError, transition } from '../domain/deal'
import { appendEvent } from '../journal/journal'
import { funnelStage } from './analytics'
import { conversationList, conversationView } from './conversations'
import { clientNames } from './feed'
import { inboxView } from './inbox'

/**
 * «Клиенты» and «Встречи» (pult v2 design 5 and 9): a client is a conversation of M4 with its stage in Boris's
 * funnel. The stage comes from the deal Sara keeps; the outcome Boris writes (a contract and its sum, or lost)
 * is the last word, and it goes to the deal as well when the deal can take it.
 */

export const CLIENT_TEXTS = {
  noted: 'Заметку сохранила.',
  won: 'Записала договор.',
  lost: 'Записала: клиент отвалился.',
  reopened: 'Итог убрала, сделка снова идёт.',
  meetingAdded: 'Встречу записала.',
  meetingOutcome: 'Итог встречи записала.',
  noClient: 'Такого клиента нет.',
  noMeeting: 'Такой встречи нет.',
} as const

type ConvRow = typeof conversation.$inferSelect

/** The stage of a client: Boris's outcome first, then the deal; a closed chat without either has dropped off. */
export function stageOf(
  c: Pick<ConvRow, 'outcome' | 'closedAt'>,
  dealStage: string | null,
): FunnelStage {
  if (c.outcome === 'won') return 'Закрыта'
  if (c.outcome === 'lost') return 'Отвалился'
  const s = funnelStage(dealStage)
  if (c.closedAt && s !== 'Закрыта') return 'Отвалился'
  // A chat that has a client's words is a conversation, even before the deal moved.
  return s
}

/** The stage of the client behind a forum topic (its key is the order's number, or `conv:` and the conversation). */
export async function stageForKey(db: DbOrTx, key: string): Promise<FunnelStage> {
  const [c] = key.startsWith('conv:')
    ? await db
        .select()
        .from(conversation)
        .where(eq(conversation.id, key.slice(5)))
    : await db.select().from(conversation).where(eq(conversation.orderId, key))
  const dealRows = c?.dealId
    ? await db.select({ stage: deal.stage }).from(deal).where(eq(deal.id, c.dealId))
    : key.startsWith('conv:')
      ? []
      : await db.select({ stage: deal.stage }).from(deal).where(eq(deal.leadId, key))
  const dealStage = dealRows[0]?.stage ?? null
  return c ? stageOf(c, dealStage) : funnelStage(dealStage)
}

async function dealStages(db: DbOrTx, convs: ConvRow[]): Promise<Map<string, string>> {
  const ids = convs.map((c) => c.dealId).filter((x): x is string => !!x)
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: deal.id, stage: deal.stage })
    .from(deal)
    .where(inArray(deal.id, ids))
  return new Map(rows.map((r) => [r.id, r.stage]))
}

/** Conversations with something open for Boris: a draft card, his held text, a quiet client, his edit asked for. */
async function waiting(db: DbOrTx): Promise<Set<string>> {
  const rows = await db.execute<{ conversation_id: string }>(sql`
    select distinct ct.conversation_id from core.task t
    join core.conv_turn ct on ct.id = t.entity_id
    where t.state = 'open' and t.kind like 'conv_%'
    union
    select distinct ct.conversation_id from core.question q
    join core.conv_turn ct on ct.id = q.entity_id
    where q.answered_at is null and q.kind = 'conv_edit'`)
  return new Set(rows.rows.map((r) => r.conversation_id))
}

export async function clientList(db: DbOrTx): Promise<ClientList> {
  const base = await conversationList(db)
  const ids = base.rows.map((r) => r.id)
  const convs = ids.length
    ? await db.select().from(conversation).where(inArray(conversation.id, ids))
    : []
  const byId = new Map(convs.map((c) => [c.id, c]))
  const stages = await dealStages(db, convs)
  const waits = await waiting(db)
  const rows: ClientRow[] = base.rows.map((r) => {
    const c = byId.get(r.id)
    return {
      id: r.id,
      name: r.name,
      title: r.title,
      stage: c ? stageOf(c, c.dealId ? (stages.get(c.dealId) ?? null) : null) : 'Отклик',
      owner: c?.owner === 'boris' ? 'boris' : 'sara',
      closed: c?.closedAt != null,
      waits: waits.has(r.id),
      last: r.last,
      lastAt: r.lastAt,
      lastSide: r.lastSide,
      amountRub: c?.amountRub ?? null,
    }
  })
  return { rows, drafting: base.drafting }
}

const meetingRow = (m: typeof meeting.$inferSelect, name: string): MeetingRow => ({
  id: m.id,
  clientId: m.conversationId,
  clientName: name,
  title: m.title,
  at: m.startsAt ? new Date(m.startsAt).toISOString() : null,
  channel: m.channel,
  note: m.note,
  outcome: (m.outcome as MeetingRow['outcome']) ?? null,
  amountRub: m.amountRub,
  source: 'manual',
})

export async function clientView(db: Db, id: string): Promise<ClientView | null> {
  const v = await conversationView(db, id)
  if (!v) return null
  const [c] = await db.select().from(conversation).where(eq(conversation.id, id))
  if (!c) return null
  const [d] = c.dealId ? await db.select().from(deal).where(eq(deal.id, c.dealId)) : []
  const spent = c.orderId
    ? await db.execute<{ rub: number }>(sql`
        select coalesce(sum((payload->>'amount_rub')::int), 0)::int as rub from core.event
        where type = 'spend.recorded' and entity_kind = 'lead' and entity_id = ${c.orderId}`)
    : { rows: [{ rub: 0 }] }
  const inbox = await inboxView(db)
  const meetings = await db
    .select()
    .from(meeting)
    .where(eq(meeting.conversationId, id))
    .orderBy(asc(meeting.startsAt))
  return {
    id,
    name: v.name,
    stage: stageOf(c, d?.stage ?? null),
    owner: v.owner,
    closed: v.closed,
    orderId: v.orderId,
    orderTitle: v.orderTitle,
    chatUrl: v.chatUrl,
    note: c.note,
    instruction: c.borisNote,
    service: c.service,
    outcome:
      c.outcome === 'won' || c.outcome === 'lost'
        ? {
            outcome: c.outcome,
            amountRub: c.amountRub,
            reason: c.outcomeReason,
            at: c.outcomeAt ?? c.updatedAt,
          }
        : null,
    spentRub: spent.rows[0]?.rub ?? 0,
    messages: v.messages,
    tasks: inbox.items.filter((i) => i.entity?.kind === 'client' && i.entity.id === id),
    meetings: meetings.map((m) => meetingRow(m, v.name)),
    sendHold: v.sendHold,
  }
}

const journal = (
  db: DbOrTx,
  type: 'client.outcome' | 'client.noted' | 'meeting.created' | 'meeting.outcome',
  entity: { kind: string; id: string },
  accountId: string | null,
  payload: Record<string, unknown>,
) =>
  appendEvent(db, {
    type,
    v: 1,
    entity,
    account_id: accountId,
    actor: 'boris',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload,
  })

/** Boris's note for the client log. */
export async function noteClient(db: Db, id: string, text: string | null): Promise<string | null> {
  const [c] = await db.select().from(conversation).where(eq(conversation.id, id))
  if (!c) return null
  await db
    .update(conversation)
    .set({ note: text, updatedAt: new Date().toISOString() })
    .where(eq(conversation.id, id))
  await journal(db, 'client.noted', { kind: 'conversation', id }, c.accountId, {
    has_note: text !== null,
  })
  return CLIENT_TEXTS.noted
}

/**
 * How the deal ended, by Boris: a contract with its sum, or lost with the reason; `null` takes the outcome back.
 * The deal Sara keeps moves too when its stages allow; the funnel and the client log read the outcome here.
 */
export async function recordOutcome(
  db: Db,
  id: string,
  o: {
    outcome: 'won' | 'lost' | null
    amountRub: number | null
    reason: string | null
    service: string | null
  },
): Promise<string | null> {
  const [c] = await db.select().from(conversation).where(eq(conversation.id, id))
  if (!c) return null
  const now = new Date().toISOString()
  await db
    .update(conversation)
    .set({
      outcome: o.outcome,
      amountRub: o.outcome === 'won' ? o.amountRub : null,
      outcomeReason: o.outcome === 'lost' ? o.reason : null,
      outcomeAt: o.outcome ? now : null,
      service: o.service ?? c.service,
      updatedAt: now,
    })
    .where(eq(conversation.id, id))
  if (o.outcome && c.dealId) {
    try {
      await transition(db, {
        dealId: c.dealId,
        to: o.outcome,
        actor: 'boris',
        reason:
          o.outcome === 'won' ? 'договор, записал Борис' : (o.reason ?? 'отвалился, записал Борис'),
        correlationId: id,
      })
    } catch (e) {
      // A deal whose stages do not lead there keeps its stage; the outcome above is what the pult reads.
      if (!(e instanceof TransitionError)) throw e
    }
  }
  await journal(db, 'client.outcome', { kind: 'conversation', id }, c.accountId, {
    outcome: o.outcome,
    amount_rub: o.outcome === 'won' ? o.amountRub : null,
  })
  return o.outcome === 'won'
    ? CLIENT_TEXTS.won
    : o.outcome === 'lost'
      ? CLIENT_TEXTS.lost
      : CLIENT_TEXTS.reopened
}

/** The calls: Boris's own, and the chats whose deal speaks of a call not yet set. */
export async function meetingList(db: DbOrTx): Promise<MeetingList> {
  const own = await db
    .select()
    .from(meeting)
    .orderBy(asc(meeting.startsAt), desc(meeting.createdAt))
  const proposed = await db
    .select({ c: conversation, stage: deal.stage })
    .from(conversation)
    .innerJoin(deal, eq(deal.id, conversation.dealId))
    .where(
      and(inArray(deal.stage, ['call_proposed', 'call_booked']), isNull(conversation.closedAt)),
    )
  const ids = [
    ...new Set([
      ...own.map((m) => m.conversationId).filter((x): x is string => !!x),
      ...proposed.map((p) => p.c.id),
    ]),
  ]
  const names = await clientNames(db, ids)
  const withOwn = new Set(own.map((m) => m.conversationId))
  const rows: MeetingRow[] = own.map((m) =>
    meetingRow(m, (m.conversationId && names.get(m.conversationId)) || 'Без клиента'),
  )
  for (const p of proposed) {
    if (withOwn.has(p.c.id)) continue
    rows.push({
      id: `deal:${p.c.id}`,
      clientId: p.c.id,
      clientName: names.get(p.c.id) ?? 'Клиент',
      title: p.stage === 'call_booked' ? 'Созвон назначен в переписке' : 'Созвон обсуждается',
      at: null,
      channel: null,
      note: 'Время не записано: добавь встречу, когда договоритесь.',
      outcome: null,
      amountRub: null,
      source: 'deal',
    })
  }
  return { rows }
}

export async function addMeeting(
  db: Db,
  m: {
    title: string
    at: string | null
    channel: string | null
    clientId: string | null
    note: string | null
  },
): Promise<string> {
  const id = newEventId()
  const [c] = m.clientId
    ? await db.select().from(conversation).where(eq(conversation.id, m.clientId))
    : []
  await db.insert(meeting).values({
    id,
    conversationId: c ? c.id : null,
    title: m.title,
    startsAt: m.at,
    channel: m.channel,
    note: m.note,
  })
  await journal(db, 'meeting.created', { kind: 'meeting', id }, c?.accountId ?? null, {
    client: c ? c.id : null,
    at: m.at,
  })
  return CLIENT_TEXTS.meetingAdded
}

/** The outcome of a call; a held call with a sum is the contract of its client too. */
export async function meetingOutcome(
  db: Db,
  id: string,
  o: { outcome: 'held' | 'missed' | 'moved'; amountRub: number | null },
): Promise<string | null> {
  const [m] = await db.select().from(meeting).where(eq(meeting.id, id))
  if (!m) return null
  await db
    .update(meeting)
    .set({ outcome: o.outcome, amountRub: o.amountRub, updatedAt: new Date().toISOString() })
    .where(eq(meeting.id, id))
  await journal(db, 'meeting.outcome', { kind: 'meeting', id }, null, {
    outcome: o.outcome,
    amount_rub: o.amountRub,
  })
  if (o.outcome === 'held' && o.amountRub !== null && m.conversationId)
    await recordOutcome(db, m.conversationId, {
      outcome: 'won',
      amountRub: o.amountRub,
      reason: null,
      service: null,
    })
  return CLIENT_TEXTS.meetingOutcome
}

/** Open things of the clients for the tabs' count: conversations that wait for Boris. */
export async function clientsWaiting(db: DbOrTx): Promise<number> {
  return (await waiting(db)).size
}
