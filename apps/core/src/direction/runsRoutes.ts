import { DirectionRules } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../api/deps'
import { directionVersion } from '../db/schema'
import { withoutLimitWait } from '../gateway/gateway'
import { adviseRules, applyAdvice, recalibrate } from './advice'
import {
  calibrationResult,
  calibrationView,
  MIN_LEADS,
  markItem,
  setNote,
  startCalibration,
} from './calibration'
import { rulesHash } from './hash'
import { getOnboarding } from './onboarding'
import { recomputePool, recomputeResult } from './recompute'
import { createRun, getRun, scheduleRun } from './runs'
import { activeRules } from './store'

const RulesSource = z.union([
  z.enum(['draft', 'active']),
  z.object({ version: z.number().int().positive() }),
])
const RunBody = z.object({ kind: z.enum(['recompute', 'calibration']), rules: RulesSource })
const MarkBody = z.object({
  lead_id: z.string().min(1).max(64),
  mark: z.enum(['yes', 'no', 'unsure']),
  note: z.string().trim().max(1000).optional(),
})
const NoteBody = z.object({ lead_id: z.string().min(1).max(64), note: z.string().trim().max(1000) })
const ApplyBody = z.object({ source: z.enum(['advice', 'threshold']) })

export const RUN_ERRORS = {
  busy: 'Идёт другая проверка, подожди.',
  noLeads:
    'Заявок для проверки пока нет. Нужно, чтобы разбор заявок был включён: он копит заявки, на которых Сара проверяется.',
  noDraft: 'Черновика правил пока нет: сначала пройди шаги настройки.',
  noVersion: 'Такой версии нет.',
  noRun: 'Такой проверки нет.',
  notMarking: 'Эта проверка уже не ждёт отметок.',
  noItem: 'Такой заявки в этой проверке нет.',
  noMisses: 'Расхождений нет, предлагать нечего.',
  noAdvice: 'Поправки нет: сначала нажми «Предложить поправку».',
  noHint: 'Порог менять не нужно: лучшего значения нет.',
  adviceFailed: 'Не получилось подобрать одну поправку. Попробуй ещё раз.',
  noAnswer: 'Claude не ответил. Попробуй ещё раз.',
  limit: 'Лимит Claude исчерпан. Попробуй позже.',
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Long checks of rules on the account's leads (recompute FR-ACC-5, calibration FR-ACC-4): start, watch, answer. */
export function registerRunRoutes(
  scoped: FastifyInstance,
  d: AppDeps,
  known: (id: string) => boolean,
  noAccount: (reply: FastifyReply) => unknown,
): void {
  const deps = () => ({ db: d.db, gateway: withoutLimitWait(d.gateway), rolesDir: d.rolesDir })

  /** The rules a check is asked about: the draft, the active ones or an old version; or an answer to give. */
  async function rulesOf(
    accountId: string,
    source: z.infer<typeof RulesSource>,
  ): Promise<{ rules: DirectionRules } | { status: number; error: string }> {
    if (source === 'active') return { rules: (await activeRules(d.db, accountId)).rules }
    if (source === 'draft') {
      const draft = (await getOnboarding(d.db, accountId))?.rules
      return draft ? { rules: draft } : { status: 409, error: RUN_ERRORS.noDraft }
    }
    const [row] = await d.db
      .select({ rules: directionVersion.rules })
      .from(directionVersion)
      .where(
        and(
          eq(directionVersion.accountId, accountId),
          eq(directionVersion.version, source.version),
        ),
      )
    return row
      ? { rules: DirectionRules.parse(row.rules) }
      : { status: 404, error: RUN_ERRORS.noVersion }
  }

  /** A run of this account, or null. */
  async function runOf(accountId: string, runId: string) {
    const run = UUID.test(runId) ? await getRun(d.db, runId) : null
    return run && run.accountId === accountId ? run : null
  }

  scoped.post('/api/directions/:accountId/runs', async (req, reply) => {
    const { accountId } = req.params as { accountId: string }
    if (!known(accountId)) return noAccount(reply)
    const body = RunBody.parse(req.body)
    const source = await rulesOf(accountId, body.rules)
    if ('error' in source) return reply.code(source.status).send({ error: source.error })

    if (body.kind === 'calibration') {
      const r = await startCalibration(d.db, { accountId, rules: source.rules })
      if (r.ok) return reply.code(201).send({ id: r.runId, total: r.total })
      return reply.code(409).send({
        error:
          r.error === 'no_leads'
            ? RUN_ERRORS.noLeads
            : `Заявок пока мало: ${r.have}, нужно хотя бы ${MIN_LEADS}.`,
      })
    }

    const leadIds = await recomputePool(d.db, accountId)
    if (leadIds.length === 0) return reply.code(409).send({ error: RUN_ERRORS.noLeads })
    const made = await createRun(d.db, {
      accountId,
      kind: 'recompute',
      rules: source.rules,
      baseRules: (await activeRules(d.db, accountId)).rules,
      leadIds,
    })
    if (!made.ok) return reply.code(409).send({ error: RUN_ERRORS.busy })
    scheduleRun(deps(), made.id)
    return reply.code(202).send({ id: made.id })
  })

  scoped.get('/api/directions/:accountId/runs/:runId', async (req, reply) => {
    const { accountId, runId } = req.params as { accountId: string; runId: string }
    if (!known(accountId)) return noAccount(reply)
    const run = await runOf(accountId, runId)
    if (!run) return reply.code(404).send({ error: RUN_ERRORS.noRun })
    const base = {
      id: run.id,
      kind: run.kind,
      state: run.state,
      total: run.total,
      done: run.done,
      skipped: run.skipped,
      stop_reason: run.stopReason,
    }
    if (run.kind === 'recompute')
      return {
        ...base,
        result: run.state === 'done' ? await recomputeResult(d.db, run.id) : null,
        calibration: null,
      }
    const marking = await calibrationView(d.db, run.id)
    // The rules this run was asked about against the rules Boris would turn on now (the draft, else the active).
    const current =
      (await getOnboarding(d.db, accountId))?.rules ?? (await activeRules(d.db, accountId)).rules
    return {
      ...base,
      result: null,
      calibration: {
        marked: marking.marked,
        // The orders and the marks only while Boris marks: the score stays hidden until he is done.
        items: run.state === 'marking' ? marking.items : [],
        result: run.state === 'done' ? await calibrationResult(d.db, run.id) : null,
        advice: run.advice ?? null,
        stale: run.rulesHash !== rulesHash(current),
      },
    }
  })

  scoped.post('/api/directions/:accountId/runs/:runId/marks', async (req, reply) => {
    const { accountId, runId } = req.params as { accountId: string; runId: string }
    if (!known(accountId)) return noAccount(reply)
    const body = MarkBody.parse(req.body)
    const run = await runOf(accountId, runId)
    if (!run || run.kind !== 'calibration') return reply.code(404).send({ error: RUN_ERRORS.noRun })
    const r = await markItem(d.db, run.id, body.lead_id, body.mark, body.note)
    if (!r.ok)
      return r.error === 'not_marking'
        ? reply.code(409).send({ error: RUN_ERRORS.notMarking })
        : reply.code(404).send({ error: RUN_ERRORS.noItem })
    // The last mark sends the run to be scored, in the background, after any check that is going on.
    if (r.complete) scheduleRun(deps(), run.id)
    return r
  })

  scoped.post('/api/directions/:accountId/runs/:runId/notes', async (req, reply) => {
    const { accountId, runId } = req.params as { accountId: string; runId: string }
    if (!known(accountId)) return noAccount(reply)
    const body = NoteBody.parse(req.body)
    const run = await runOf(accountId, runId)
    if (!run || run.kind !== 'calibration') return reply.code(404).send({ error: RUN_ERRORS.noRun })
    await setNote(d.db, run.id, body.lead_id, body.note)
    return { ok: true }
  })

  scoped.post('/api/directions/:accountId/runs/:runId/advice', async (req, reply) => {
    const { accountId, runId } = req.params as { accountId: string; runId: string }
    if (!known(accountId)) return noAccount(reply)
    const r = await adviseRules(
      { db: d.db, gateway: withoutLimitWait(d.gateway) },
      accountId,
      runId,
    )
    if (r.ok) return { advice: r.advice }
    const answer = {
      no_run: [404, RUN_ERRORS.noRun],
      no_misses: [409, RUN_ERRORS.noMisses],
      invalid: [422, RUN_ERRORS.adviceFailed],
      not_one_change: [422, RUN_ERRORS.adviceFailed],
      no_answer: [502, RUN_ERRORS.noAnswer],
      limit: [503, RUN_ERRORS.limit],
    } as const
    const [status, error] = answer[r.reason]
    return reply.code(status).send({ error, reason: r.reason })
  })

  scoped.post('/api/directions/:accountId/runs/:runId/apply', async (req, reply) => {
    const { accountId, runId } = req.params as { accountId: string; runId: string }
    if (!known(accountId)) return noAccount(reply)
    const { source } = ApplyBody.parse(req.body)
    const r = await applyAdvice(d.db, accountId, runId, source)
    if (!r.ok) {
      const answer = {
        no_run: [404, RUN_ERRORS.noRun],
        no_advice: [409, RUN_ERRORS.noAdvice],
        no_hint: [409, RUN_ERRORS.noHint],
        busy: [409, RUN_ERRORS.busy],
      } as const
      const [status, error] = answer[r.error]
      return reply.code(status).send({ error })
    }
    scheduleRun(deps(), r.runId)
    return { id: r.runId }
  })

  scoped.post('/api/directions/:accountId/runs/:runId/recalibrate', async (req, reply) => {
    const { accountId, runId } = req.params as { accountId: string; runId: string }
    if (!known(accountId)) return noAccount(reply)
    const r = UUID.test(runId)
      ? await recalibrate(d.db, accountId, runId)
      : { ok: false as const, error: 'no_run' as const }
    if (!r.ok)
      return reply
        .code(r.error === 'busy' ? 409 : 404)
        .send({ error: r.error === 'busy' ? RUN_ERRORS.busy : RUN_ERRORS.noRun })
    scheduleRun(deps(), r.runId)
    return { id: r.runId }
  })
}
