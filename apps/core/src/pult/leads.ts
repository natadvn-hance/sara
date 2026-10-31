import {
  AnalystOutput,
  ClientInfo,
  combinedScore,
  formatRub,
  type LeadQueue,
  type LeadRow,
  type LeadScores,
  LeadScreen,
  type LeadView,
  priceUpTo,
  type QueueOrder,
} from '@sara/shared'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { account, bidHold, directionVersion, lead, leadLabel, leadScore, task } from '../db/schema'
import { FOLLOW_UP_EDIT_MAX } from '../leads/draft'
import { dayOf } from '../leads/money'
import { getSetting } from '../settings/store'

/** «Заявки» (M7 design 5.3): the queue by value and one lead with its score, разбор, bid text and obstacles. */

const DAY_MS = 24 * 3600 * 1000
/** Profi.ru takes up to 500 characters in a bid. */
export const BID_LIMIT = 500

export const orderUrl = (id: string) =>
  `https://profi.ru/backoffice/n.php?o=${encodeURIComponent(id)}`

const READING_RU: Record<keyof AnalystOutput['reading'], string> = {
  said: 'Говорит прямо',
  layers: 'Между строк',
  wants: 'Чего хочет на самом деле',
  who: 'Кто это',
  risks: 'Риски',
  job: 'Зачем нанимает',
}

/** The lead's last live score (not a backtest), one per lead. */
async function lastScores(db: DbOrTx, ids: string[]) {
  if (ids.length === 0) return new Map<string, typeof leadScore.$inferSelect>()
  const rows = await db
    .select()
    .from(leadScore)
    .where(and(inArray(leadScore.leadId, ids), eq(leadScore.backtest, false)))
    .orderBy(desc(leadScore.createdAt))
  const out = new Map<string, typeof leadScore.$inferSelect>()
  for (const r of rows) if (!out.has(r.leadId)) out.set(r.leadId, r)
  return out
}

/** How many days of decided leads the «Решённые» list shows. */
const DECIDED_DAYS = 30

/**
 * The two numbers of a lead (Boris, 29.10.2026: «Два числа»). The scoring of today gives one number, the fit to
 * Hance; the chance of a deal comes with the scoring v2 and is «считается» until then. This is the one place that
 * reads a score row into the two numbers.
 */
export function scoresOf(s: typeof leadScore.$inferSelect | undefined): LeadScores {
  if (!s)
    return {
      fit: { value: null, reasons: [] },
      chance: { value: null, reasons: [] },
      combined: null,
    }
  const axes = ((s.axes ?? []) as { why?: string }[])
    .map((a) => a.why)
    .filter((w): w is string => !!w)
  const fit = { value: s.score, reasons: [s.reason, ...axes].filter(Boolean) }
  const chance = { value: null, reasons: [] }
  return { fit, chance, combined: combinedScore(fit.value, chance.value) }
}

const orderValue = (r: LeadRow, order: QueueOrder): number => {
  const v =
    order === 'fit'
      ? r.scores?.fit.value
      : order === 'chance'
        ? r.scores?.chance.value
        : r.scores?.combined
  return v ?? -1
}

/** The holds still waiting, by task. */
async function heldBy(db: DbOrTx, taskIds: string[]): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map()
  const rows = await db
    .select({ taskId: bidHold.taskId, at: bidHold.executeAt })
    .from(bidHold)
    .where(and(inArray(bidHold.taskId, taskIds), eq(bidHold.state, 'held')))
  return new Map(rows.map((r) => [r.taskId, new Date(r.at).toISOString()]))
}

/** Why no press would spend now, alike for every lead: the pause of bids. */
async function pausedText(db: DbOrTx): Promise<string | null> {
  return (await getSetting(db, 'outbound.bids'))
    ? null
    : 'Отклики на паузе: «Откликнуться» сейчас ничего не потратит и ответит, что пауза.'
}

export async function leadQueue(
  db: DbOrTx,
  now = new Date(),
  order: QueueOrder = 'combined',
): Promise<LeadQueue> {
  const open = await db
    .select({ t: task, l: lead })
    .from(task)
    .innerJoin(lead, eq(lead.id, task.entityId))
    .where(and(eq(task.kind, 'lead_decision'), eq(task.state, 'open')))
  const dayAgo = now.getTime() - DAY_MS
  const fresh = open.filter((r) => Date.parse(r.l.seenAt) >= dayAgo)
  const scores = await lastScores(
    db,
    fresh.map((r) => r.l.id),
  )
  const held = await heldBy(
    db,
    fresh.map((r) => r.t.id),
  )
  const queue: LeadRow[] = fresh
    .map(({ t, l }) => ({
      id: l.id,
      taskId: t.id,
      title: l.title,
      city: l.city,
      category: l.category,
      score: scores.get(l.id)?.score ?? null,
      scores: scoresOf(scores.get(l.id)),
      feeRub: l.bidPriceRub,
      priceFromRub: l.draftPriceRub,
      seenAt: l.seenAt,
      hasDraft: l.draftText !== null,
      heldUntil: held.get(t.id) ?? null,
    }))
    // The most valuable first (FR-LEAD-10): the two numbers together (or the one Boris chose), then the cheaper bid.
    .sort((a, b) => orderValue(b, order) - orderValue(a, order) || a.feeRub - b.feeRub)
  const since = new Date(now.getTime() - DECIDED_DAYS * DAY_MS).toISOString()
  const decidedRows = await db
    .select({ t: task, l: lead, reason: leadLabel.reason })
    .from(task)
    .innerJoin(lead, eq(lead.id, task.entityId))
    .leftJoin(leadLabel, eq(leadLabel.leadId, lead.id))
    .where(
      and(eq(task.kind, 'lead_decision'), eq(task.state, 'resolved'), gt(task.resolvedAt, since)),
    )
    .orderBy(desc(task.resolvedAt))
    .limit(100)
  const decision = (r: string | null): LeadQueue['decided'][number]['decision'] =>
    r === 'bid' || r === 'skip' ? r : r === 'closed' || r === 'closed_on_site' ? 'closed' : 'other'
  return {
    queue,
    older: open.length - fresh.length,
    decided: decidedRows.map(({ t, l, reason }) => ({
      id: l.id,
      title: l.title,
      decision: decision(t.resolution),
      at: t.resolvedAt ?? t.createdAt,
      feeRub: l.bidPriceRub,
      reason: reason ?? null,
    })),
    paused: await pausedText(db),
  }
}

/** What would refuse a bid on this lead now, by the same rules as `refuseSpend`, read without its lock. */
export async function bidObstacles(
  db: DbOrTx,
  l: typeof lead.$inferSelect,
  now = new Date(),
): Promise<string[]> {
  const out: string[] = []
  if (!(await getSetting(db, 'outbound.bids'))) out.push('отклики на паузе')
  if (l.draftText === null) out.push('текста отклика ещё нет')
  else if (l.draftPriceRub === null) out.push('не указана стоимость услуги')
  if (l.bidPriceRub <= 0) out.push('цена отклика ещё не известна')
  const [a] = await db.select().from(account).where(eq(account.id, l.accountId))
  if (a?.paused) out.push('аккаунт на паузе')
  if (a?.loginState === 'dead' || a?.loginState === 'banned')
    out.push('аккаунт не вошёл в Профи.ру')
  const max = await getSetting(db, 'money.max_fee_rub')
  if (max !== null && l.bidPriceRub > max) out.push(`дороже потолка ${formatRub(max)} за отклик`)
  const day = await dayOf(db, now)
  if (a?.balanceRub !== null && a?.balanceRub !== undefined && l.bidPriceRub > 0) {
    const free = a.balanceRub - day.queuedRub
    if (free < l.bidPriceRub) out.push(`не хватает ${formatRub(l.bidPriceRub - free)} на кошельке`)
  }
  const budget = await getSetting(db, 'money.daily_budget_rub')
  const spent = day.spent + day.pendingRub
  if (budget !== null && spent + l.bidPriceRub > budget)
    out.push(`бюджет дня: осталось ${formatRub(Math.max(0, budget - spent))}`)
  const cap = await getSetting(db, 'money.daily_bids')
  if (day.sent + day.pending >= cap) out.push(`лимит дня: ${day.sent + day.pending} из ${cap}`)
  return out
}

export async function leadView(db: DbOrTx, id: string): Promise<LeadView | null> {
  const [l] = await db.select().from(lead).where(eq(lead.id, id))
  if (!l) return null
  const s = (await lastScores(db, [l.id])).get(l.id)
  const [rules] = s
    ? await db
        .select({ rules: directionVersion.rules })
        .from(directionVersion)
        .where(
          and(eq(directionVersion.accountId, l.accountId), eq(directionVersion.version, s.version)),
        )
    : []
  const r = rules?.rules as
    | { threshold?: number; axes?: { id: string; title: string; weight: number }[] }
    | undefined
  const axisOf = new Map((r?.axes ?? []).map((a) => [a.id, a]))
  const axes = ((s?.axes ?? []) as { id: string; score: number; why: string }[]).map((a) => ({
    title: axisOf.get(a.id)?.title ?? a.id,
    weight: axisOf.get(a.id)?.weight ?? null,
    score: a.score,
    why: a.why,
  }))
  const parsed = AnalystOutput.pick({ hidden_need: true, risk: true, condition: true }).safeParse(
    l.draftAnalysis,
  )
  const reading = AnalystOutput.shape.reading.safeParse(
    (l.draftAnalysis as { reading?: unknown } | null)?.reading,
  )
  const info = ClientInfo.safeParse(l.clientInfo)
  const [t] = await db
    .select()
    .from(task)
    .where(and(eq(task.entityId, l.id), eq(task.kind, 'lead_decision')))
    .orderBy(desc(task.createdAt))
    .limit(1)
  const reviews =
    info.success && info.data.reviews
      ? `отзывов от исполнителей: ${info.data.reviews.positive} хороших, ${info.data.reviews.negative} плохих`
      : null
  return {
    lead: {
      id: l.id,
      accountId: l.accountId,
      title: l.title,
      city: l.city,
      category: l.category,
      text: l.text,
      budgetText: l.budgetText,
      clientName: l.clientName,
      client: info.success
        ? { since: info.data.on_profi_since, phone: info.data.phone_verified, reviews }
        : null,
      seenAt: l.seenAt,
      status: l.status,
      feeRub: l.bidPriceRub,
      url: orderUrl(l.id),
    },
    screen: LeadScreen.safeParse(l.screen).data ?? null,
    score: s
      ? {
          value: s.score,
          scores: scoresOf(s),
          confidence: s.confidence,
          threshold: r?.threshold ?? null,
          rulesVersion: s.version,
          reason: s.reason,
          stopFactor: s.stopFactor,
          redFlags: (s.redFlags as string[]) ?? [],
          axes,
        }
      : null,
    analysis: parsed.success
      ? {
          hiddenNeed: parsed.data.hidden_need,
          risk: parsed.data.risk,
          condition: parsed.data.condition,
          reading: reading.success
            ? Object.entries(reading.data).map(([k, v]) => ({
                label: READING_RU[k as keyof typeof READING_RU] ?? k,
                text: v,
              }))
            : [],
        }
      : null,
    bid: {
      text: l.draftText,
      priceFromRub: l.draftPriceRub,
      priceToRub: l.draftPriceRub === null ? null : priceUpTo(l.draftPriceRub),
      limit: BID_LIMIT,
      followUps: l.draftFollowUps ?? [],
      followUpLimit: FOLLOW_UP_EDIT_MAX,
    },
    task: t ? { id: t.id, open: t.state === 'open', resolution: t.resolution } : null,
    obstacles: t?.state === 'open' ? await bidObstacles(db, l) : [],
    hold: t?.state === 'open' ? await holdOf(db, t.id) : null,
    label: await labelOf(db, l.id),
  }
}

async function holdOf(db: DbOrTx, taskId: string) {
  const [h] = await db.select().from(bidHold).where(eq(bidHold.taskId, taskId))
  return h?.state === 'held'
    ? { requestId: h.requestId, executeAt: new Date(h.executeAt).toISOString() }
    : null
}

async function labelOf(db: DbOrTx, leadId: string) {
  const [x] = await db
    .select({ label: leadLabel.label, reason: leadLabel.reason })
    .from(leadLabel)
    .where(eq(leadLabel.leadId, leadId))
  return x ? { label: x.label, reason: x.reason } : null
}

/** The fee the pult showed must still be the lead's: a changed price asks for a new press (M7 design 5.3). */
export async function feeChanged(
  db: DbOrTx,
  taskId: string,
  expectedFeeRub: number,
): Promise<string | null> {
  const [row] = await db
    .select({ fee: lead.bidPriceRub })
    .from(task)
    .innerJoin(lead, eq(lead.id, task.entityId))
    .where(eq(task.id, taskId))
  if (!row || row.fee === expectedFeeRub) return null
  return `Цена изменилась: было ${formatRub(expectedFeeRub)}, стало ${formatRub(row.fee)}. Нажми ещё раз.`
}

/** Leads waiting for a decision, fresh ones only (FR-LEAD-10). */
export async function openLeadCount(db: DbOrTx, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - DAY_MS).toISOString()
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(task)
    .innerJoin(lead, eq(lead.id, task.entityId))
    .where(and(eq(task.kind, 'lead_decision'), eq(task.state, 'open'), gt(lead.seenAt, since)))
  return r?.n ?? 0
}
