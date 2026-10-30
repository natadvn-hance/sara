import { QUEUE_ORDERS, SETTINGS, TASK_ACTIONS, type TaskAction } from '@sara/shared'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../api/deps'
import { requireSession } from '../auth/session'
import { question, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { markSeen, noticeList, putAway } from '../notify/center'
import { setSetting } from '../settings/store'
import { analyticsView } from './analytics'
import { conversationList, conversationView } from './conversations'
import { inboxView } from './inbox'
import { journalView, traceView } from './journalView'
import { feeChanged, leadQueue, leadView } from './leads'
import { mindRecordView, mindView } from './mind'
import { searchView } from './search'
import { pultMay, settingsView } from './settings'
import { registerStreamRoute } from './stream'
import { systemView } from './system'
import { todayView } from './today'

export const PULT_TEXTS = {
  notFound: 'Такого нет. Возможно, его уже убрали.',
  starting: 'Сара ещё запускается, нажми через минуту.',
  noAction: 'Это действие из пульта пока недоступно, сделай его в Telegram.',
  noFee: 'Нужна цена отклика, которую ты видел.',
  locked: 'Это меняется не здесь: включает разработчик после проверок, выключить можно паузой.',
  badValue: 'Такое значение не подходит.',
  noText: 'Нужен текст отклика или стоимость услуги.',
  decided: 'Заявка уже решена.',
  answered: 'Вопрос уже закрыт.',
  noAnswer: 'Нужен текст ответа.',
  skippedQuestion: 'Хорошо, не важно.',
  seen: 'Просмотрено.',
  putAway: 'Убрала.',
} as const

/**
 * The actions the pult offers per task kind (pult v2 design 3). Each is the press of the Telegram button: the same
 * function and the same events; nothing here writes to a client by itself.
 */
export const PULT_ACTIONS: Record<string, readonly TaskAction[]> = {
  lead_decision: ['bid', 'skip'],
  lead_review: ['want'],
  lead_held: ['open'],
  rule_proposal: ['apply', 'drop'],
  // A reply card: «Отправить», «Беру сам», «Закрыть»; a reminder card: «Отправить», «Не надо» (skip).
  conv_draft: ['send', 'take', 'close', 'skip'],
  conv_dormant: ['close'],
  conv_say: ['send'],
}

const PressBody = z.object({
  expectedFeeRub: z.number().int().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
})
const TextBody = z
  .object({
    text: z.string().trim().min(1).max(2000).nullable().default(null),
    priceRub: z.number().int().positive().max(100_000_000).nullable().default(null),
    /** The whole series after the bid as Boris left it; absent, it stays as it is. */
    followUps: z.array(z.string().max(2000)).max(5).nullable().default(null),
  })
  .refine((b) => b.text !== null || b.priceRub !== null || b.followUps !== null)
const AnswerBody = z.object({ text: z.string().trim().min(1).max(4000) })
const SeenBody = z.object({ ids: z.array(z.uuid()).max(500) })
const Period = z.object({ period: z.enum(['7', '30']).default('7') })
const Year = z.object({ year: z.coerce.number().int().min(2020).max(2100).optional() })
const NoticeQuery = z.object({ state: z.enum(['new', 'open', 'all']).default('all') })
const JournalQuery = z.object({
  type: z.string().max(80).optional(),
  kind: z.string().max(40).optional(),
  id: z.string().max(120).optional(),
  before: z.string().max(40).optional(),
})
const SearchQuery = z.object({ q: z.string().max(200).default('') })
const LeadsQuery = z.object({ order: z.enum(QUEUE_ORDERS).default('combined') })
const BidBody = z.object({ expectedFeeRub: z.number().int() })
const SkipBody = z.object({ reason: z.string().trim().min(1).max(500).optional() })

/** The pult's screens (contract C4 in `@sara/shared`): read only, plus presses, answers and limits. */
export function registerPultRoutes(app: FastifyInstance, d: AppDeps): void {
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)
    scoped.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store')
      return payload
    })

    scoped.get('/api/today', async (req) => {
      const { period } = Period.parse(req.query ?? {})
      return todayView(d.db, Number(period))
    })
    scoped.get('/api/inbox', async () => inboxView(d.db))
    scoped.get('/api/notices', async (req) => {
      const { state } = NoticeQuery.parse(req.query ?? {})
      return noticeList(d.db, { state })
    })
    scoped.get('/api/leads', async (req) => {
      const { order } = LeadsQuery.parse(req.query ?? {})
      return leadQueue(d.db, new Date(), order)
    })
    scoped.get('/api/leads/:id', async (req, reply) => {
      const v = await leadView(d.db, (req.params as { id: string }).id)
      return v ?? reply.code(404).send({ error: PULT_TEXTS.notFound })
    })
    scoped.get('/api/conversations', async () => conversationList(d.db))
    scoped.get('/api/conversations/:id', async (req, reply) => {
      const v = await conversationView(d.db, (req.params as { id: string }).id)
      return v ?? reply.code(404).send({ error: PULT_TEXTS.notFound })
    })
    scoped.get('/api/analytics', async (req) => {
      const { year } = Year.parse(req.query ?? {})
      return analyticsView(d.db, year ?? new Date().getFullYear())
    })
    scoped.get('/api/mind', async () => mindView(d.db))
    scoped.get('/api/mind/:id', async (req, reply) => {
      const v = await mindRecordView(d.db, (req.params as { id: string }).id)
      return v ?? reply.code(404).send({ error: PULT_TEXTS.notFound })
    })
    scoped.get('/api/settings', async () => settingsView(d.db))
    scoped.get('/api/system', async () => systemView(d))
    scoped.get('/api/journal', async (req) =>
      journalView(d.db, JournalQuery.parse(req.query ?? {})),
    )
    scoped.get('/api/journal/trace/:id', async (req, reply) => {
      const v = await traceView(d.db, (req.params as { id: string }).id)
      return v ?? reply.code(404).send({ error: PULT_TEXTS.notFound })
    })
    scoped.get('/api/search', async (req) => searchView(d.db, SearchQuery.parse(req.query ?? {}).q))

    scoped.post('/api/tasks/:id/:action', async (req, reply) => {
      const { id, action } = req.params as { id: string; action: string }
      if (!z.uuid().safeParse(id).success)
        return reply.code(404).send({ error: PULT_TEXTS.notFound })
      const [t] = await d.db.select().from(task).where(eq(task.id, id))
      if (!t) return reply.code(404).send({ error: PULT_TEXTS.notFound })
      const a = action as TaskAction
      if (!TASK_ACTIONS.includes(a) || !PULT_ACTIONS[t.kind]?.includes(a))
        return reply.code(400).send({ error: PULT_TEXTS.noAction })
      const body = PressBody.parse(req.body ?? {})
      if (a === 'bid') {
        // Money goes only at the price Boris saw on the screen (M7 design 5.3), and from the pult always after the
        // ten seconds to cancel (pult v2 design 4).
        if (body.expectedFeeRub === undefined)
          return reply.code(400).send({ error: PULT_TEXTS.noFee })
        const changed = await feeChanged(d.db, id, body.expectedFeeRub)
        if (changed) return reply.code(409).send({ error: changed, code: 'fee_changed' })
        if (!d.bids) return reply.code(503).send({ error: PULT_TEXTS.starting })
        const r = await d.bids.hold(t.entityId, body.expectedFeeRub)
        return r.ok
          ? { message: r.message, executeAt: r.executeAt }
          : reply.code(r.status).send({ error: r.message, code: r.code })
      }
      if (!d.onPress) return reply.code(503).send({ error: PULT_TEXTS.starting })
      const message = await d.onPress({
        taskId: id,
        action: a,
        source: 'pult',
        reason: body.reason ?? null,
      })
      return { message }
    })

    scoped.post('/api/questions/:id/answer', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!z.uuid().safeParse(id).success)
        return reply.code(404).send({ error: PULT_TEXTS.notFound })
      const body = AnswerBody.safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: PULT_TEXTS.noAnswer })
      const [q] = await d.db.select().from(question).where(eq(question.id, id))
      if (!q) return reply.code(404).send({ error: PULT_TEXTS.notFound })
      if (q.answeredAt) return reply.code(409).send({ error: PULT_TEXTS.answered })
      if (!d.answerQuestion) return reply.code(503).send({ error: PULT_TEXTS.starting })
      return { message: await d.answerQuestion(q, body.data.text) }
    })

    scoped.post('/api/questions/:id/skip', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!z.uuid().safeParse(id).success)
        return reply.code(404).send({ error: PULT_TEXTS.notFound })
      const now = new Date().toISOString()
      const rows = await d.db
        .update(question)
        .set({ answeredAt: now })
        .where(and(eq(question.id, id), isNull(question.answeredAt)))
        .returning({ kind: question.kind })
      if (rows.length === 0) return reply.code(409).send({ error: PULT_TEXTS.answered })
      await appendEvent(d.db, {
        type: 'question.answered',
        v: 1,
        entity: { kind: 'question', id },
        account_id: null,
        actor: 'boris',
        occurred_at: now,
        causation_id: null,
        correlation_id: id,
        reason: 'skipped',
        payload: { kind: rows[0]?.kind, voice: false, skipped: true },
      })
      return { message: PULT_TEXTS.skippedQuestion }
    })

    scoped.post('/api/notices/seen', async (req) => {
      const { ids } = SeenBody.parse(req.body ?? {})
      await markSeen(d.db, ids)
      return { message: PULT_TEXTS.seen }
    })
    scoped.post('/api/notices/:id/done', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!z.uuid().safeParse(id).success || !(await putAway(d.db, id)))
        return reply.code(404).send({ error: PULT_TEXTS.notFound })
      return { message: PULT_TEXTS.putAway }
    })

    scoped.post('/api/leads/:id/bid', async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = BidBody.safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: PULT_TEXTS.noFee })
      if (!d.bids) return reply.code(503).send({ error: PULT_TEXTS.starting })
      const r = await d.bids.hold(id, body.data.expectedFeeRub)
      return r.ok
        ? { message: r.message, executeAt: r.executeAt }
        : reply.code(r.status).send({ error: r.message, code: r.code })
    })

    scoped.post('/api/leads/:id/bid/cancel', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!d.bids) return reply.code(503).send({ error: PULT_TEXTS.starting })
      const r = await d.bids.cancel(id)
      return r.ok ? { message: r.message } : reply.code(409).send({ error: r.message })
    })

    scoped.post('/api/leads/:id/skip', async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = SkipBody.safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: PULT_TEXTS.badValue })
      const [t] = await d.db
        .select({ id: task.id })
        .from(task)
        .where(and(eq(task.entityId, id), eq(task.kind, 'lead_decision'), eq(task.state, 'open')))
      if (!t) return reply.code(409).send({ error: PULT_TEXTS.decided })
      if (!d.onPress) return reply.code(503).send({ error: PULT_TEXTS.starting })
      const message = await d.onPress({
        taskId: t.id,
        action: 'skip',
        source: 'pult',
        reason: body.data.reason ?? null,
      })
      return { message }
    })

    scoped.post('/api/leads/:id/recheck', async (req, reply) => {
      const { id } = req.params as { id: string }
      if (!d.bids) return reply.code(503).send({ error: PULT_TEXTS.starting })
      return d.bids.recheck(id)
    })

    scoped.post('/api/leads/:id/text', async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = TextBody.safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: PULT_TEXTS.noText })
      const [t] = await d.db
        .select({ id: task.id })
        .from(task)
        .where(and(eq(task.entityId, id), eq(task.kind, 'lead_decision'), eq(task.state, 'open')))
      if (!t) return reply.code(409).send({ error: PULT_TEXTS.decided })
      if (!d.saveBidText) return reply.code(503).send({ error: PULT_TEXTS.starting })
      const r = await d.saveBidText({ taskId: t.id, ...body.data })
      return r.saved ? { message: r.message } : reply.code(409).send({ error: r.message })
    })

    scoped.post('/api/settings/:key', async (req, reply) => {
      const { key } = req.params as { key: string }
      const value = (req.body as { value?: unknown } | null)?.value
      if (!(key in SETTINGS)) return reply.code(404).send({ error: PULT_TEXTS.notFound })
      if (!pultMay(key, value)) return reply.code(403).send({ error: PULT_TEXTS.locked })
      const parsed = SETTINGS[key].schema.safeParse(value)
      if (!parsed.success) return reply.code(400).send({ error: PULT_TEXTS.badValue })
      await setSetting(d.db, key, parsed.data as never, 'boris')
      return { message: 'Сохранила.' }
    })

    registerStreamRoute(scoped)
  })
}
