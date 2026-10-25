import { desc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { requireSession } from '../auth/session'
import { mindCommit } from '../db/schema'
import type { SchoolDeps } from './types'

/** What Boris's screens hear back from a revert (FR-MIND-3). */
const REVERT_HTTP: Record<string, number> = {
  conflict: 409,
  unknown: 404,
  locked: 503,
  no_git: 503,
}

/**
 * The school's API (M5 design 5.20), behind the owner's sign-in. The parts add their routes here; M7's
 * `requireOwner` (the Telegram signature) replaces `requireSession` when it is in main.
 */
export function registerSchoolRoutes(app: FastifyInstance, d: SchoolDeps): void {
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)

    /** The mind's recent commits, newest first: what was written, reverted, sent to GitHub. */
    scoped.get('/api/mind/commits', async () => {
      const rows = await d.db
        .select()
        .from(mindCommit)
        .orderBy(desc(mindCommit.createdAt))
        .limit(50)
      return rows.map((c) => ({
        id: c.id,
        kind: c.kind,
        lessons: ((c.lessonIds as string[]) ?? []).length,
        reverts: c.revertsId,
        createdAt: c.createdAt,
        pushedAt: c.pushedAt,
      }))
    })

    /** One button brings the previous mind version back (FR-MIND-3). */
    scoped.post<{ Params: { id: string } }>('/api/mind/commits/:id/revert', async (req, reply) => {
      const r = await d.writer.revert(req.params.id)
      if (r.ok) return { ok: true, commitId: r.commitId }
      return reply.code(REVERT_HTTP[r.reason] ?? 500).send({ ok: false, error: r.detail })
    })
  })
}
