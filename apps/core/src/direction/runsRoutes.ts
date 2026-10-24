import { DirectionRules } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../api/deps'
import { directionVersion } from '../db/schema'
import { withoutLimitWait } from '../gateway/gateway'
import { getOnboarding } from './onboarding'
import { recomputePool, recomputeResult } from './recompute'
import { createRun, getRun, runWorker } from './runs'
import { activeRules } from './store'

const RunBody = z.object({
  kind: z.enum(['recompute']),
  rules: z.union([z.enum(['draft', 'active']), z.object({ version: z.number().int().positive() })]),
})

export const RUN_ERRORS = {
  busy: 'Идёт другая проверка, подожди.',
  noLeads:
    'Заявок для проверки пока нет. Нужно, чтобы разбор заявок был включён: он копит заявки, на которых Сара проверяется.',
  noDraft: 'Черновика правил пока нет: сначала пройди шаги настройки.',
  noVersion: 'Такой версии нет.',
  noRun: 'Такой проверки нет.',
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Starting a long check of rules on the account's leads, and watching it (FR-ACC-5). */
export function registerRunRoutes(
  scoped: FastifyInstance,
  d: AppDeps,
  known: (id: string) => boolean,
  noAccount: (reply: FastifyReply) => unknown,
): void {
  scoped.post('/api/directions/:accountId/runs', async (req, reply) => {
    const { accountId } = req.params as { accountId: string }
    if (!known(accountId)) return noAccount(reply)
    const body = RunBody.parse(req.body)
    const active = await activeRules(d.db, accountId)
    let rules: DirectionRules
    if (body.rules === 'active') rules = active.rules
    else if (body.rules === 'draft') {
      const draft = (await getOnboarding(d.db, accountId))?.rules
      if (!draft) return reply.code(409).send({ error: RUN_ERRORS.noDraft })
      rules = draft
    } else {
      const [row] = await d.db
        .select({ rules: directionVersion.rules })
        .from(directionVersion)
        .where(
          and(
            eq(directionVersion.accountId, accountId),
            eq(directionVersion.version, body.rules.version),
          ),
        )
      if (!row) return reply.code(404).send({ error: RUN_ERRORS.noVersion })
      rules = DirectionRules.parse(row.rules)
    }
    const leadIds = await recomputePool(d.db, accountId)
    if (leadIds.length === 0) return reply.code(409).send({ error: RUN_ERRORS.noLeads })
    const made = await createRun(d.db, {
      accountId,
      kind: body.kind,
      rules,
      baseRules: active.rules,
      leadIds,
    })
    if (!made.ok) return reply.code(409).send({ error: RUN_ERRORS.busy })
    // In the background, through a Claude limit it does not wait: the run stops and says so.
    void runWorker(
      { db: d.db, gateway: withoutLimitWait(d.gateway), rolesDir: d.rolesDir },
      made.id,
    ).catch((e) => console.error('direction run crashed', e))
    return reply.code(202).send({ id: made.id })
  })

  scoped.get('/api/directions/:accountId/runs/:runId', async (req, reply) => {
    const { accountId, runId } = req.params as { accountId: string; runId: string }
    if (!known(accountId)) return noAccount(reply)
    const run = UUID.test(runId) ? await getRun(d.db, runId) : null
    if (!run || run.accountId !== accountId)
      return reply.code(404).send({ error: RUN_ERRORS.noRun })
    return {
      id: run.id,
      kind: run.kind,
      state: run.state,
      total: run.total,
      done: run.done,
      skipped: run.skipped,
      stop_reason: run.stopReason,
      result: run.state === 'done' ? await recomputeResult(d.db, run.id) : null,
    }
  })
}
