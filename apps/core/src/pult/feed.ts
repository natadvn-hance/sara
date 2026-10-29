import { type FeedItem, formatRub, type LineTone, type SettingKey } from '@sara/shared'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { conversation, convTurn, event, lead, task } from '../db/schema'
import { SETTING_META } from './settings'

/**
 * The feed of «Сегодня»: Sara's steps from the journal in Boris's words (M7). Only the types below are shown; the
 * rest of the journal (model calls, outbox steps) is plumbing Boris never reads.
 */

type Row = typeof event.$inferSelect
type Said = { area: FeedItem['area']; tone: LineTone; text: string }
/** What a card was about: its task's lead or conversation, by the task's id. */
type Card = { area: FeedItem['area']; text: string; link: string | null }
type Names = { lead: Map<string, string>; client: Map<string, string>; card: Map<string, Card> }

const q = (s: string | undefined) => (s ? `«${s}»` : 'заявку')
const num = (p: unknown, k: string): number | null => {
  const v = (p as Record<string, unknown> | null)?.[k]
  return typeof v === 'number' ? v : null
}
const str = (p: unknown, k: string): string | null => {
  const v = (p as Record<string, unknown> | null)?.[k]
  return typeof v === 'string' ? v : null
}

const SAYS: Record<string, (e: Row, n: Names) => Said | null> = {
  'lead.found': (e, n) => ({
    area: 'lead',
    tone: 'ok',
    text: `Нашла заявку ${q(n.lead.get(e.entityId))}`,
  }),
  'lead.scored': (e, n) => {
    const score = num(e.payload, 'score')
    const pass = str(e.payload, 'decision') !== 'skip'
    return {
      area: 'lead',
      tone: 'ok',
      text: `Оценила ${q(n.lead.get(e.entityId))}${score === null ? '' : `: балл ${score}`}${pass ? '' : ', не наша'}`,
    }
  },
  'lead.drafted': (e, n) => ({
    area: 'lead',
    tone: 'ok',
    text: `Написала отклик на ${q(n.lead.get(e.entityId))}`,
  }),
  'card.sent': (e, n) => {
    const c = n.card.get(e.entityId)
    if (c) return { area: c.area, tone: 'wait', text: c.text }
    return n.lead.has(e.entityId)
      ? { area: 'lead', tone: 'wait', text: `Прислала тебе карточку ${q(n.lead.get(e.entityId))}` }
      : { area: 'lead', tone: 'wait', text: 'Прислала тебе карточку' }
  },
  'lead.skipped': (e, n) => ({
    area: 'lead',
    tone: 'ok',
    text: `Пропустили ${q(n.lead.get(e.entityId))}`,
  }),
  'lead.closed_on_site': (e, n) => ({
    area: 'lead',
    tone: 'ok',
    text: `${q(n.lead.get(e.entityId))} закрылась на Профи.ру`,
  }),
  'lead.stale': (e, n) => ({
    area: 'lead',
    tone: 'ok',
    text: `${q(n.lead.get(e.entityId))} устарела, карточку не слала`,
  }),
  'bid.sent': (e, n) => {
    const rub = num(e.payload, 'spent_rub')
    return {
      area: 'bid',
      tone: 'ok',
      text: `Откликнулась на ${q(n.lead.get(e.entityId))}${rub === null ? '' : ` за ${formatRub(rub)}`}`,
    }
  },
  'bid.failed': (e, n) => ({
    area: 'bid',
    tone: 'bad',
    text: `Отклик на ${q(n.lead.get(e.entityId))} не ушёл`,
  }),
  'bid.series_sent': (e, n) => ({
    area: 'bid',
    tone: 'ok',
    text: `Написала вдогонку к отклику на ${q(n.lead.get(e.entityId))}`,
  }),
  'conv.message_heard': (e, n) => ({
    area: 'conv',
    tone: 'wait',
    text: `${who(e, n)}: новое сообщение в чате`,
  }),
  'conv.turn_drafted': (e, n) => ({
    area: 'conv',
    tone: 'wait',
    text: `Подготовила ответ: ${who(e, n)}`,
  }),
  'conv.turn_sent': (e, n) => ({ area: 'conv', tone: 'ok', text: `Ответила: ${who(e, n)}` }),
  'conv.turn_failed': (e, n) => ({
    area: 'conv',
    tone: 'bad',
    text: `Ответ не ушёл: ${who(e, n)}`,
  }),
  'conv.reminder_drafted': (e, n) => ({
    area: 'conv',
    tone: 'wait',
    text: `Подготовила напоминание: ${who(e, n)}`,
  }),
  'conv.reminder_sent': (e, n) => ({
    area: 'conv',
    tone: 'ok',
    text: `Напомнила о себе: ${who(e, n)}`,
  }),
  'conv.taken': (e, n) => ({ area: 'conv', tone: 'ok', text: `Ты взял клиента: ${who(e, n)}` }),
  'conv.returned': (e, n) => ({
    area: 'conv',
    tone: 'ok',
    text: `Клиент снова у меня: ${who(e, n)}`,
  }),
  'conv.closed': (e, n) => ({ area: 'conv', tone: 'ok', text: `Разговор закрыт: ${who(e, n)}` }),
  'conv.said': (e, n) => ({ area: 'conv', tone: 'ok', text: `Отправила твой текст: ${who(e, n)}` }),
  'mind.proposed': () => ({
    area: 'mind',
    tone: 'wait',
    text: 'Предложила запись в разум, ждёт твоего «да»',
  }),
  'mind.written': () => ({ area: 'mind', tone: 'ok', text: 'Записала выученное в разум' }),
  'rules.proposed': () => ({
    area: 'lead',
    tone: 'wait',
    text: 'Предложила поправку правил отбора',
  }),
  'rules.applied': () => ({ area: 'lead', tone: 'ok', text: 'Правила отбора поправлены' }),
  'school.night_ran': () => ({ area: 'mind', tone: 'ok', text: 'Ночная школа прошла' }),
  'profi.session_dead': () => ({
    area: 'system',
    tone: 'bad',
    text: 'Профи.ру разлогинил аккаунт',
  }),
  'profi.session_alive': () => ({
    area: 'system',
    tone: 'ok',
    text: 'Сессия Профи.ру снова живая',
  }),
  'profi.connection_lost': () => ({ area: 'system', tone: 'bad', text: 'Нет связи с Профи.ру' }),
  'profi.connection_back': () => ({
    area: 'system',
    tone: 'ok',
    text: 'Связь с Профи.ру вернулась',
  }),
  'profi.balance_changed': (e) => {
    const rub = num(e.payload, 'balance_rub')
    return {
      area: 'money',
      tone: 'ok',
      text: rub === null ? 'Кошелёк изменился' : `На кошельке ${formatRub(rub)}`,
    }
  },
  // Only the settings the pult names; the wizard's progress and the like are plumbing.
  'setting.changed': (e) => {
    const title = SETTING_META[e.entityId as SettingKey]?.title
    return title ? { area: 'system', tone: 'ok', text: `Изменена настройка «${title}»` } : null
  },
}

/** The event types the feed shows. */
export const FEED_TYPES = Object.keys(SAYS)

function who(e: Row, n: Names): string {
  return n.client.get(e.entityId) ?? 'клиент'
}

function linkOf(e: Row, n: Names): string | null {
  const card = e.type === 'card.sent' ? n.card.get(e.entityId) : undefined
  if (card) return card.link
  if (e.entityKind === 'lead') return `/leads/${encodeURIComponent(e.entityId)}`
  if (e.entityKind === 'conversation') return `/clients/${e.entityId}`
  if (e.type.startsWith('profi.')) return '/health'
  if (e.type.startsWith('mind.') || e.type.startsWith('school.')) return '/mind'
  return null
}

/** The client's name of each conversation: the order's client, or the chat's number when no order is known. */
export async function clientNames(db: DbOrTx, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const uuids = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  if (uuids.length === 0) return out
  const convs = await db.select().from(conversation).where(inArray(conversation.id, uuids))
  const orders = convs.map((c) => c.orderId).filter((x): x is string => !!x)
  const leads = orders.length
    ? await db
        .select({ id: lead.id, name: lead.clientName })
        .from(lead)
        .where(inArray(lead.id, orders))
    : []
  const byOrder = new Map(leads.map((l) => [l.id, l.name]))
  // A chat begun by old Sara has no lead here: the name is taken from our own greeting («Дарья, добрый день!»).
  const unnamed = convs.filter((c) => !(c.orderId && byOrder.get(c.orderId))).map((c) => c.id)
  const greeted = unnamed.length
    ? await db.execute<{ conversation_id: string; text: string }>(sql`
        select distinct on (conversation_id) conversation_id, text from core.chat_message
        where conversation_id in ${unnamed} and side <> 'client'
          and text ~ '^[А-ЯЁ][а-яё]{1,20}, (добрый|доброе|здравствуйте)'
        order by conversation_id, sent_at`)
    : { rows: [] }
  const byGreeting = new Map(
    greeted.rows.map((r) => [r.conversation_id, r.text.split(',')[0]?.trim() ?? '']),
  )
  for (const c of convs)
    out.set(
      c.id,
      (c.orderId && byOrder.get(c.orderId)) ||
        byGreeting.get(c.id) ||
        (c.orderId ? `Клиент по заказу ${c.orderId}` : `Чат ${c.chatId}`),
    )
  return out
}

/** The cards behind `card.sent` events: a lead card names its order, a conversation card its client. */
async function cardsOf(db: DbOrTx, taskIds: string[]): Promise<Map<string, Card>> {
  const out = new Map<string, Card>()
  const ids = taskIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  if (ids.length === 0) return out
  const leadCards = await db
    .select({ id: task.id, leadId: lead.id, title: lead.title })
    .from(task)
    .innerJoin(lead, eq(lead.id, task.entityId))
    .where(inArray(task.id, ids))
  for (const c of leadCards)
    out.set(c.id, {
      area: 'lead',
      text: `Прислала тебе карточку «${c.title}»`,
      link: `/leads/${encodeURIComponent(c.leadId)}`,
    })
  const convCards = await db
    .select({ id: task.id, conversationId: convTurn.conversationId })
    .from(task)
    .innerJoin(convTurn, sql`${convTurn.id} = ${task.entityId}`)
    .where(inArray(task.id, ids))
  const who = await clientNames(
    db,
    convCards.map((c) => c.conversationId),
  )
  for (const c of convCards)
    out.set(c.id, {
      area: 'conv',
      text: `Прислала тебе черновик ответа: ${who.get(c.conversationId) ?? 'клиент'}`,
      link: `/clients/${c.conversationId}`,
    })
  return out
}

/** The rows the feed knows how to say, in Boris's words, by the event's id (the journal uses it too). */
export async function describeEvents(db: DbOrTx, rows: Row[]): Promise<Map<string, FeedItem>> {
  const out = new Map<string, FeedItem>()
  for (const f of await sayRows(db, rows)) out.set(f.id, f)
  return out
}

/** The last `limit` shown steps, newest first. */
export async function readFeed(db: DbOrTx, limit = 40): Promise<FeedItem[]> {
  const rows = await db
    .select()
    .from(event)
    .where(inArray(event.type, FEED_TYPES))
    .orderBy(desc(event.occurredAt))
    .limit(limit)
  return sayRows(db, rows)
}

async function sayRows(db: DbOrTx, rows: Row[]): Promise<FeedItem[]> {
  const leadIds = [...new Set(rows.filter((r) => r.entityKind === 'lead').map((r) => r.entityId))]
  const titles = leadIds.length
    ? await db
        .select({ id: lead.id, title: lead.title })
        .from(lead)
        .where(inArray(lead.id, leadIds))
    : []
  const names: Names = {
    card: await cardsOf(
      db,
      rows.filter((r) => r.type === 'card.sent' && r.entityKind === 'task').map((r) => r.entityId),
    ),
    lead: new Map(titles.map((t) => [t.id, t.title])),
    client: await clientNames(
      db,
      rows.filter((r) => r.entityKind === 'conversation').map((r) => r.entityId),
    ),
  }
  const out: FeedItem[] = []
  for (const r of rows) {
    const said = SAYS[r.type]?.(r, names)
    if (said) out.push({ id: r.id, at: r.occurredAt, link: linkOf(r, names), ...said })
  }
  return out
}
