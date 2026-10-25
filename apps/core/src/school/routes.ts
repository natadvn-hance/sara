import { desc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { requireSession } from '../auth/session'
import { mindCommit } from '../db/schema'
import {
  answerInterview,
  confirmInterview,
  interviewQueue,
  isInterviewLesson,
  resolveCard,
  skipInterview,
} from './interview'
import type { SchoolDeps } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

    /** The interview's questions, first the ones from work (FR-MIND-4). */
    scoped.get('/api/interview', async () => interviewQueue(d.db, new Date()))

    /** Boris's answer: what Sara understood comes back for «Правильно понимаю?». */
    scoped.post<{ Params: { gapKey: string }; Body: { text?: string } }>(
      '/api/interview/:gapKey/answer',
      async (req, reply) => {
        const text = req.body?.text?.trim()
        if (!text) return reply.code(400).send({ error: 'Нужен ответ' })
        const r = await answerInterview(d, req.params.gapKey, text, new Date())
        if (r.ok) return r.understood
        // The model did not answer this time: the screen may send the same answer again.
        return reply.code(r.why === 'retry' ? 503 : 409).send({ error: r.reason })
      },
    )

    /** «Да, записать» or «Не знаю, пропустить» on what Sara understood. */
    scoped.post<{ Params: { id: string }; Body: { decision?: string } }>(
      '/api/interview/lessons/:id',
      async (req, reply) => {
        const decision = req.body?.decision
        const id = req.params.id
        if (decision !== 'yes' && decision !== 'skip')
          return reply.code(400).send({ error: 'Нужно yes или skip' })
        if (!UUID.test(id) || !(await isInterviewLesson(d.db, id)))
          return reply.code(404).send({ error: 'Нет такой записи интервью' })
        const now = new Date()
        // The Telegram card of the same record is done too, so its buttons never decide it twice.
        await resolveCard(d.db, id, decision === 'yes' ? 'apply' : 'skip', now)
        return {
          text:
            decision === 'yes' ? await confirmInterview(d, id) : await skipInterview(d.db, id, now),
        }
      },
    )

    /** One button brings the previous mind version back (FR-MIND-3). */
    scoped.post<{ Params: { id: string } }>('/api/mind/commits/:id/revert', async (req, reply) => {
      if (!UUID.test(req.params.id))
        return reply.code(404).send({ ok: false, error: 'нет такой записи' })
      const r = await d.writer.revert(req.params.id)
      if (r.ok) return { ok: true, commitId: r.commitId }
      return reply.code(REVERT_HTTP[r.reason] ?? 500).send({ ok: false, error: r.detail })
    })
  })
}
