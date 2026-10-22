import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../api/deps'
import { requireSession } from '../auth/session'
import { recheckClaude, runHealthChecks } from './checks'

export function registerHealthRoutes(app: FastifyInstance, d: AppDeps): void {
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)
    scoped.get('/api/health', async () => ({ checks: await runHealthChecks(d) }))
    scoped.post('/api/health/claude', async () => {
      await recheckClaude(d)
      return { checks: await runHealthChecks(d) }
    })
  })
}
