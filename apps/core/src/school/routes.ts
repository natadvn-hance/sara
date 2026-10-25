import type { FastifyInstance } from 'fastify'
import { requireSession } from '../auth/session'
import type { SchoolDeps } from './types'

/**
 * The school's API (M5 design 5.20), behind the owner's sign-in. The parts add their routes here; M7's
 * `requireOwner` (the Telegram signature) replaces `requireSession` when it is in main.
 */
export function registerSchoolRoutes(app: FastifyInstance, _d: SchoolDeps): void {
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)
  })
}
