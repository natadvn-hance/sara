import { formatRub, type PultState, plural, type TodayView, type WaitingItem } from '@sara/shared'
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { account, convTurn, event, lead, question, task } from '../db/schema'
import { dayOf } from '../leads/money'
import { getSetting } from '../settings/store'
import { draftsWaiting } from './conversations'
import { clientNames, readFeed } from './feed'
import { leadQueue } from './leads'
import { claudeLimit } from './system'

/** «Сегодня» (M7 design 5.1): the day in ten seconds. */

const MSK = 'Europe/Moscow'
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: MSK })

const QUESTION_RU: Record<string, string> = {
  why_skip: 'Почему пропустил заявку?',
  why_want: 'Почему взял заявку?',
  conv_edit: 'Жду твой вариант ответа клиенту',
  draft_text: 'Жду новый текст отклика',
  draft_price: 'Жду стоимость услуги для отклика',
}

/** The worst first, in Boris's words; the rest of the list goes to the detail line. */
async function stateOf(db: Db, shortRub: number | null): Promise<PultState> {
  const said: { tone: PultState['tone']; text: string }[] = []
  const accounts = await db.select().from(account)
  if (accounts.some((a) => a.loginState === 'dead' || a.loginState === 'banned'))
    said.push({ tone: 'bad', text: 'Профи.ру разлогинил аккаунт, нужен вход' })
  const [link] = await db
    .select({ type: event.type })
    .from(event)
    .where(inArray(event.type, ['profi.connection_lost', 'profi.connection_back']))
    .orderBy(desc(event.occurredAt))
    .limit(1)
  if (link?.type === 'profi.connection_lost')
    said.push({ tone: 'bad', text: 'Нет связи с Профи.ру' })
  const limit = await claudeLimit(db)
  if (limit.limited)
    said.push({
      tone: 'warn',
      text: limit.until ? `Лимит Claude до ${hhmm(limit.until)}` : 'Кончился лимит Claude',
    })
  if (accounts.some((a) => a.paused)) said.push({ tone: 'warn', text: 'Аккаунт на паузе' })
  if (!(await getSetting(db, 'outbound.bids')))
    said.push({ tone: 'wait', text: 'Отклики на паузе' })
  if (shortRub !== null)
    said.push({ tone: 'warn', text: `Не хватает ${formatRub(shortRub)} на отклик` })
  if (await getSetting(db, 'conv.v1_writes'))
    said.push({ tone: 'wait', text: 'Тень: клиентам пишет старая Сара или ты' })
  else if (!(await getSetting(db, 'conv.autopilot')))
    said.push({ tone: 'wait', text: 'Режим черновиков: клиентам пишу только после «Отправить»' })
  const order = ['bad', 'warn', 'wait', 'ok'] as const
  said.sort((a, b) => order.indexOf(a.tone) - order.indexOf(b.tone))
  const [first, ...rest] = said
  if (!first) return { tone: 'ok', text: 'Работает', detail: null }
  return { ...first, detail: rest.length ? rest.map((r) => r.text).join(' · ') : null }
}

/** What Sara is busy with now: a turn being thought over, the limit, else the watch over the board. */
async function doingOf(
  db: Db,
  limited: boolean,
  lastAt: string | null,
): Promise<TodayView['doing']> {
  if (limited)
    return {
      text: 'Жду, когда вернётся лимит Claude; новые сообщения клиентов присылаю сразу',
      at: null,
    }
  const since = new Date(Date.now() - 10 * 60_000).toISOString()
  const [turn] = await db
    .select({ id: convTurn.conversationId, at: convTurn.createdAt })
    .from(convTurn)
    .where(and(isNull(convTurn.finishedAt), gt(convTurn.createdAt, since)))
    .orderBy(desc(convTurn.createdAt))
    .limit(1)
  if (turn) {
    const name = (await clientNames(db, [turn.id])).get(turn.id) ?? 'клиенту'
    return { text: `Думаю над ответом: ${name}`, at: turn.at }
  }
  return { text: 'Слежу за лентой заявок и чатами Профи.ру', at: lastAt }
}

/** A period of 7 or 30 days: found, passed the rules, bids, replies, wins and money. */
async function periodOf(db: Db, days: number): Promise<TodayView['period']> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
  const r = await db.execute<Omit<TodayView['period'], 'days'>>(sql`
    select
      (select count(*)::int from core.lead where seen_at >= ${since}) as found,
      (select count(*)::int from core.task where kind = 'lead_decision' and created_at >= ${since}) as passed,
      (select count(distinct entity_id)::int from core.event where type = 'bid.sent' and occurred_at >= ${since}) as bids,
      (select count(*)::int from core.deal where created_at >= ${since}
         and stage in ('talking','call_proposed','call_booked','call_done','won')) as replied,
      (select count(*)::int from core.deal where created_at >= ${since} and stage = 'won') as won,
      (select coalesce(sum((payload->>'amount_rub')::int), 0)::int from core.event
         where type = 'spend.recorded' and occurred_at >= ${since}) as "spentRub"`)
  const row = r.rows[0]
  if (!row) throw new Error('the period is not readable')
  return { days, ...row }
}

export async function todayView(db: Db, days: number, now = new Date()): Promise<TodayView> {
  const queue = await leadQueue(db, now)
  const [acc] = await db.select().from(account).orderBy(account.id).limit(1)
  const cheapest = queue.queue
    .filter((l) => l.feeRub > 0)
    .map((l) => l.feeRub)
    .sort((a, b) => a - b)[0]
  const balance = acc?.balanceRub ?? null
  const shortRub =
    balance !== null && cheapest !== undefined && balance < cheapest ? cheapest - balance : null

  const items: WaitingItem[] = []
  if (queue.queue.length) {
    const n = queue.queue.length
    items.push({
      id: 'leads',
      kind: 'leads',
      title: `${n} ${plural(n, ['заявка ждёт', 'заявки ждут', 'заявок ждут'])} решения`,
      sub: queue.queue[0] ? `сверху «${queue.queue[0].title}»` : null,
      at: queue.queue[0]?.seenAt ?? now.toISOString(),
      link: '/leads',
    })
  }
  const drafts = await draftsWaiting(db)
  const names = await clientNames(
    db,
    drafts.map((d) => d.conversationId),
  )
  for (const d of drafts)
    items.push({
      id: `draft:${d.conversationId}`,
      kind: 'draft',
      title: `${names.get(d.conversationId) ?? 'Клиент'}: ${d.reminder ? 'напоминание' : 'черновик'} ждёт «Отправить»`,
      sub: null,
      at: d.at,
      link: `/conversations/${d.conversationId}`,
    })
  const questions = await db
    .select()
    .from(question)
    .where(isNull(question.answeredAt))
    .orderBy(desc(question.askedAt))
    .limit(5)
  const qTitles = new Map(
    (
      await db
        .select({ id: lead.id, title: lead.title })
        .from(lead)
        .where(inArray(lead.id, questions.map((q) => q.entityId).concat('')))
    ).map((l) => [l.id, l.title]),
  )
  for (const q of questions)
    items.push({
      id: `q:${q.id}`,
      kind: 'question',
      title: QUESTION_RU[q.kind] ?? 'Сара спрашивает в Telegram',
      sub: qTitles.get(q.entityId)
        ? `«${qTitles.get(q.entityId)}», ответь в Telegram`
        : 'ответь в Telegram',
      at: q.askedAt,
      link: qTitles.has(q.entityId) ? `/leads/${encodeURIComponent(q.entityId)}` : null,
    })
  const rules = await db
    .select()
    .from(task)
    .where(and(eq(task.kind, 'rule_proposal'), eq(task.state, 'open')))
  for (const t of rules)
    items.push({
      id: `rules:${t.id}`,
      kind: 'rules',
      title: 'Поправка правил отбора ждёт решения',
      sub: 'кнопки в Telegram',
      at: t.createdAt,
      link: '/settings',
    })

  const day = await dayOf(db, now)
  const cards = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from core.event where type = 'card.sent'
      and occurred_at >= ((${now.toISOString()}::timestamptz at time zone ${MSK})::date::timestamp at time zone ${MSK})`)
  const feed = await readFeed(db)
  const limit = await claudeLimit(db)
  return {
    now: now.toISOString(),
    state: await stateOf(db, shortRub),
    doing: await doingOf(db, limit.limited, feed[0]?.at ?? null),
    waiting: {
      leads: queue.queue.length,
      drafts: drafts.length,
      questions: questions.length,
      items,
    },
    wallet: { balanceRub: balance, at: acc?.balanceAt ?? null, shortRub },
    day: {
      bids: day.sent,
      bidsCap: await getSetting(db, 'money.daily_bids'),
      spentRub: day.spent,
      budgetRub: await getSetting(db, 'money.daily_budget_rub'),
      maxFeeRub: await getSetting(db, 'money.max_fee_rub'),
      cards: cards.rows[0]?.n ?? 0,
      cardsCap: await getSetting(db, 'cards.max_per_day'),
    },
    feed,
    period: await periodOf(db, days),
  }
}
