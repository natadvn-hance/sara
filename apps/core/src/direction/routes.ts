import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../api/deps'
import { requireSession } from '../auth/session'
import { getProfile } from './profile'
import { activeRules, listVersions, rollbackTo } from './store'

const RollbackBody = z.object({ version: z.number().int().positive() })

export const DIRECTION_ERRORS = {
  noAccount: 'Такого аккаунта нет.',
  noVersion: 'Такой версии нет.',
  alreadyActive: 'Эта версия уже действует.',
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
        onboarding: null,
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
  })
}
