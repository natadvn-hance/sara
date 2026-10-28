import { type FeedItem, formatRub, type LineTone } from '@sara/shared'
import { desc, inArray } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { conversation, event, lead } from '../db/schema'

/**
 * The feed of «Сегодня»: Sara's steps from the journal in Boris's words (M7). Only the types below are shown; the
 * rest of the journal (model calls, outbox steps) is plumbing Boris never reads.
 */

type Row = typeof event.$inferSelect
type Said = { area: FeedItem['area']; tone: LineTone; text: string }
type Names = { lead: Map<string, string>; client: Map<string, string> }

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
  'card.sent': (e, n) =>
    e.entityKind === 'lead' || n.lead.has(e.entityId)
      ? { area: 'lead', tone: 'wait', text: `Прислала тебе карточку ${q(n.lead.get(e.entityId))}` }
      : { area: 'conv', tone: 'wait', text: 'Прислала тебе карточку разговора' },
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
  'conv.message_heard': (e, n) => ({
    area: 'conv',
    tone: 'wait',
    text: `${who(e, n)} написал в чат`,
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
  'setting.changed': (e) => ({
    area: 'system',
    tone: 'ok',
    text: `Изменена настройка ${e.entityId}`,
  }),
}

/** The event types the feed shows. */
export const FEED_TYPES = Object.keys(SAYS)

function who(e: Row, n: Names): string {
  return n.client.get(e.entityId) ?? 'клиент'
}

function linkOf(e: Row): string | null {
  if (e.entityKind === 'lead') return `/leads/${encodeURIComponent(e.entityId)}`
  if (e.entityKind === 'conversation') return `/conversations/${e.entityId}`
  if (e.type.startsWith('profi.')) return '/system'
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
  for (const c of convs) out.set(c.id, (c.orderId && byOrder.get(c.orderId)) || `чат ${c.chatId}`)
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
  const leadIds = [...new Set(rows.filter((r) => r.entityKind === 'lead').map((r) => r.entityId))]
  const titles = leadIds.length
    ? await db
        .select({ id: lead.id, title: lead.title })
        .from(lead)
        .where(inArray(lead.id, leadIds))
    : []
  const names: Names = {
    lead: new Map(titles.map((t) => [t.id, t.title])),
    client: await clientNames(
      db,
      rows.filter((r) => r.entityKind === 'conversation').map((r) => r.entityId),
    ),
  }
  const out: FeedItem[] = []
  for (const r of rows) {
    const said = SAYS[r.type]?.(r, names)
    if (said) out.push({ id: r.id, at: r.occurredAt, link: linkOf(r), ...said })
  }
  return out
}
