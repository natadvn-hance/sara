import { SETTINGS, TASK_ACTIONS, type TaskAction } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../api/deps'
import { requireSession } from '../auth/session'
import { task } from '../db/schema'
import { setSetting } from '../settings/store'
import { analyticsView } from './analytics'
import { conversationList, conversationView } from './conversations'
import { feeChanged, leadQueue, leadView } from './leads'
import { mindRecordView, mindView } from './mind'
import { pultMay, settingsView } from './settings'
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
  decided: 'Заявка уже решена, текст больше не правится.',
} as const

/**
 * The actions the pult offers per task kind (M7 design 5.2). Each is the press of the Telegram button: the same
 * function and the same events; nothing here writes to a client by itself.
 */
export const PULT_ACTIONS: Record<string, readonly TaskAction[]> = {
  lead_decision: ['bid', 'skip'],
  // A reply card: «Отправить», «Беру сам», «Закрыть»; a reminder card: «Отправить», «Не надо» (skip).
  conv_draft: ['send', 'take', 'close', 'skip'],
}

const DONE_RU: Partial<Record<TaskAction, string>> = {
  bid: 'отклик',
  skip: 'пропущено',
  send: 'отправлено',
  take: 'клиент твой',
  close: 'закрыто',
}

/** A task the press decided gets its Telegram card marked, so the chat keeps no live buttons (M7 design 2). */
async function markCard(d: AppDeps, taskId: string, action: TaskAction): Promise<void> {
  const [t] = await d.db.select().from(task).where(eq(task.id, taskId))
  if (!t || t.state === 'open' || !t.telegramMessageId) return
  try {
    await d.bot.notifier.markDone?.(
      t.telegramMessageId,
      `Решено в приложении: ${DONE_RU[action] ?? 'готово'}`,
    )
  } catch (e) {
    console.error('card not marked', e instanceof Error ? e.message.slice(0, 200) : e)
  }
}

const PressBody = z.object({ expectedFeeRub: z.number().int().optional() })
const TextBody = z
  .object({
    text: z.string().trim().min(1).max(2000).nullable().default(null),
    priceRub: z.number().int().positive().max(100_000_000).nullable().default(null),
    /** The whole series after the bid as Boris left it; absent, it stays as it is. */
    followUps: z.array(z.string().max(2000)).max(5).nullable().default(null),
  })
  .refine((b) => b.text !== null || b.priceRub !== null || b.followUps !== null)
const Period = z.object({ period: z.enum(['7', '30']).default('7') })
const Year = z.object({ year: z.coerce.number().int().min(2020).max(2100).optional() })

/** The pult's screens (M7, contract C4 in `@sara/shared` pult.ts): read only, plus presses and limits. */
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
    scoped.get('/api/leads', async () => leadQueue(d.db))
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

    scoped.post('/api/tasks/:id/:action', async (req, reply) => {
      const { id, action } = req.params as { id: string; action: string }
      if (!z.uuid().safeParse(id).success)
        return reply.code(404).send({ error: PULT_TEXTS.notFound })
      const [t] = await d.db.select().from(task).where(eq(task.id, id))
      if (!t) return reply.code(404).send({ error: PULT_TEXTS.notFound })
      const a = action as TaskAction
      if (!TASK_ACTIONS.includes(a) || !PULT_ACTIONS[t.kind]?.includes(a))
        return reply.code(400).send({ error: PULT_TEXTS.noAction })
      if (a === 'bid') {
        // Money goes only at the price Boris saw on the screen (M7 design 5.3).
        const body = PressBody.parse(req.body ?? {})
        if (body.expectedFeeRub === undefined)
          return reply.code(400).send({ error: PULT_TEXTS.noFee })
        const changed = await feeChanged(d.db, id, body.expectedFeeRub)
        if (changed) return reply.code(409).send({ error: changed, code: 'fee_changed' })
      }
      if (!d.onPress) return reply.code(503).send({ error: PULT_TEXTS.starting })
      const message = await d.onPress({ taskId: id, action: a })
      await markCard(d, id, a)
      return { message }
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
  })
}
