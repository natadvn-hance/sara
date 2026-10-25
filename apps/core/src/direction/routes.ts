import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../api/deps'
import { requireSession } from '../auth/session'
import {
  cancelOnboarding,
  confirmStep,
  finishOnboarding,
  getOnboarding,
  rebaseOnboarding,
  skipStep,
  startOnboarding,
  submitStep,
} from './onboarding'
import { getProfile } from './profile'
import { registerRunRoutes } from './runsRoutes'
import { activeRules, listVersions, rollbackTo } from './store'

const RollbackBody = z.object({ version: z.number().int().positive() })
const StartBody = z.object({ mode: z.enum(['new', 'edit']) })
const SayBody = z.object({
  say: z.string().trim().min(1).max(4000),
  fix: z.string().trim().min(1).max(2000).optional(),
})
const FinishBody = z.object({ override: z.object({ reason: z.string().max(1000) }).optional() })
const StepParams = z.object({ accountId: z.string(), n: z.coerce.number().int() })

export const DIRECTION_ERRORS = {
  noAccount: 'Такого аккаунта нет.',
  noVersion: 'Такой версии нет.',
  alreadyActive: 'Эта версия уже действует.',
  noOnboarding: 'Настройка не начата.',
  nothingToConfirm: 'Нечего подтверждать: сначала расскажи про этот шаг.',
  cannotSkip: 'Этот шаг пропустить нельзя.',
  badStep: 'Такого шага нет.',
  noAnswer: 'Claude не ответил. Попробуй ещё раз.',
  broken: 'Черновик не читается: отмени его и начни настройку заново.',
  invalid: 'Не получилось собрать, попробуй сказать иначе.',
  limit: 'Лимит Claude исчерпан. Попробуй позже.',
  closed: 'Настройка уже закончена или отменена.',
  stale: 'Правила изменились, пока ты настраивал. Обнови черновик.',
  incomplete: 'Не все шаги подтверждены.',
  needsCalibration: 'Сначала проверь правила на заявках.',
} as const

/** The pult's direction pages (FR-ACC-2): what the direction is now, its versions, and the way back. */
export function registerDirectionRoutes(app: FastifyInstance, d: AppDeps): void {
  const account = (id: string) => d.accounts?.find((a) => a.id === id)
  const noAccount = (reply: FastifyReply) =>
    reply.code(404).send({ error: DIRECTION_ERRORS.noAccount })

  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)

    scoped.get('/api/directions/:accountId', async (req, reply) => {
      const { accountId } = req.params as { accountId: string }
      const acc = account(accountId)
      if (!acc) return noAccount(reply)
      const [active, versions, profile] = await Promise.all([
        activeRules(d.db, accountId),
        listVersions(d.db, accountId),
        getProfile(d.db, accountId),
      ])
      return {
        account: { id: acc.id, title: acc.title },
        state: profile.state,
        active,
        versions,
        profile: {
          speed: profile.speed,
          reply_format: profile.reply_format,
          cases: profile.cases,
          version: profile.version,
        },
        onboarding: await (async () => {
          const o = await getOnboarding(d.db, accountId)
          return o ? { open: true, step: o.step } : null
        })(),
      }
    })

    // A rollback never rewrites history: it is a new version carrying the old rules (FR-MIND-3).
    scoped.post('/api/directions/:accountId/rollback', async (req, reply) => {
      const { accountId } = req.params as { accountId: string }
      if (!account(accountId)) return noAccount(reply)
      const { version } = RollbackBody.parse(req.body)
      const known = await listVersions(d.db, accountId)
      const target = known.find((v) => v.version === version)
      if (!target) return reply.code(404).send({ error: DIRECTION_ERRORS.noVersion })
      if (target.active) return reply.code(409).send({ error: DIRECTION_ERRORS.alreadyActive })
      return { version: await rollbackTo(d.db, accountId, version) }
    })

    // The onboarding (FR-ACC-3): one open draft per account, saved at every step.
    scoped.get('/api/directions/:accountId/onboarding', async (req, reply) => {
      const { accountId } = req.params as { accountId: string }
      if (!account(accountId)) return noAccount(reply)
      return { onboarding: await getOnboarding(d.db, accountId) }
    })

    scoped.post('/api/directions/:accountId/onboarding', async (req, reply) => {
      const { accountId } = req.params as { accountId: string }
      if (!account(accountId)) return noAccount(reply)
      const { mode } = StartBody.parse(req.body)
      return { onboarding: await startOnboarding(d.db, accountId, mode) }
    })

    scoped.post('/api/directions/:accountId/onboarding/steps/:n', async (req, reply) => {
      const { accountId, n } = StepParams.parse(req.params)
      if (!account(accountId)) return noAccount(reply)
      const r = await submitStep(
        { db: d.db, gateway: d.gateway },
        accountId,
        n,
        SayBody.parse(req.body),
      )
      if (r.ok) return { onboarding: r.view }
      const answer = {
        no_onboarding: [409, DIRECTION_ERRORS.noOnboarding],
        bad_step: [400, DIRECTION_ERRORS.badStep],
        no_answer: [502, DIRECTION_ERRORS.noAnswer],
        invalid: [422, DIRECTION_ERRORS.invalid],
        limit: [503, DIRECTION_ERRORS.limit],
        broken: [409, DIRECTION_ERRORS.broken],
      } as const
      const [status, error] = answer[r.reason]
      return reply.code(status).send({ error, reason: r.reason })
    })

    scoped.post('/api/directions/:accountId/onboarding/steps/:n/confirm', async (req, reply) => {
      const { accountId, n } = StepParams.parse(req.params)
      if (!account(accountId)) return noAccount(reply)
      const view = await confirmStep(d.db, accountId, n)
      if (!view) return reply.code(409).send({ error: DIRECTION_ERRORS.nothingToConfirm })
      return { onboarding: view }
    })

    scoped.post('/api/directions/:accountId/onboarding/steps/:n/skip', async (req, reply) => {
      const { accountId, n } = StepParams.parse(req.params)
      if (!account(accountId)) return noAccount(reply)
      const view = await skipStep(d.db, accountId, n)
      if (!view) return reply.code(409).send({ error: DIRECTION_ERRORS.cannotSkip })
      return { onboarding: view }
    })

    scoped.post('/api/directions/:accountId/onboarding/rebase', async (req, reply) => {
      const { accountId } = req.params as { accountId: string }
      if (!account(accountId)) return noAccount(reply)
      const view = await rebaseOnboarding(d.db, accountId)
      if (!view) return reply.code(409).send({ error: DIRECTION_ERRORS.noOnboarding })
      return { onboarding: view }
    })

    scoped.post('/api/directions/:accountId/onboarding/cancel', async (req, reply) => {
      const { accountId } = req.params as { accountId: string }
      if (!account(accountId)) return noAccount(reply)
      await cancelOnboarding(d.db, accountId)
      return { ok: true }
    })

    scoped.post('/api/directions/:accountId/onboarding/finish', async (req, reply) => {
      const { accountId } = req.params as { accountId: string }
      if (!account(accountId)) return noAccount(reply)
      const r = await finishOnboarding(d.db, accountId, FinishBody.parse(req.body ?? {}))
      if (r.ok) return { version: r.version }
      const answer = {
        closed: DIRECTION_ERRORS.closed,
        stale: DIRECTION_ERRORS.stale,
        incomplete: DIRECTION_ERRORS.incomplete,
        needs_calibration: DIRECTION_ERRORS.needsCalibration,
      } as const
      return reply.code(409).send({ error: answer[r.error], code: r.error })
    })
    registerRunRoutes(scoped, d, (id) => account(id) !== undefined, noAccount)
  })
}
