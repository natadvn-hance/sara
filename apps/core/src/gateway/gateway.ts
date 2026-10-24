import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MODELS, newEventId, ProbeOutput, type RoleMeta } from '@sara/shared'
import { desc, eq, inArray, or } from 'drizzle-orm'
import { type ZodType, z } from 'zod'
import type { Db } from '../db/client'
import { modelCall } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { Notifier } from '../notify/notifier'
import type { SecretStore } from '../secrets/store'
import { buildClaudeArgs, type CliRun, roleJsonSchema, runClaude } from './claudeCli'
import { createLimitGuard, createLimitNotice, type LimitGuard, parseResetAt } from './limit'
import { createSlots } from './queue'
import { type Redacted, redact, restore } from './redact'
import { loadRole, type RoleName } from './roles'

export type GatewayErrorClass =
  | 'not_connected'
  | 'timeout'
  | 'bad_output'
  | 'cli_failed'
  | 'limit_reached'

export type RoleCallResult<T> =
  | { ok: true; output: T; durationMs: number; modelCallId: string }
  | {
      ok: false
      errorClass: GatewayErrorClass
      message: string
      durationMs: number
      modelCallId: string
    }

export type CallOptions = {
  correlationId?: string
  causationId?: string
  /** This call's model instead of the role's, with no fallback (the caller chose it). */
  model?: RoleMeta['model']
  /** How long a P1-P3 call may wait out the Claude limit (default 6 hours); 0 meets it with limit_reached at once. */
  limitWaitMs?: number
  /** Client names to hide from the model, besides the phones, e-mails and links it never sees (ADR-016). */
  redact?: { names?: (string | null | undefined)[] }
}

export type Gateway = {
  call<T>(
    role: RoleName,
    input: string,
    schema: ZodType<T>,
    opts?: CallOptions,
  ): Promise<RoleCallResult<T>>
}

const MINUTE_MS = 60_000
type Model = RoleMeta['model']

type Outcome =
  | { ok: true; output: unknown }
  | { ok: false; errorClass: GatewayErrorClass; message: string }

/** The subscription limit only: "Context limit reached" and the like are other failures. */
const LIMIT_TEXT =
  /usage limit|rate limit|hit your (?:[\w'-]+ )*limit|(?:session|weekly|spend|\d+-hour) limit reached/i
const AUTH_TEXT = /failed to authenticate|invalid api key|oauth|not logged in|please run \/login/i

function classify<T>(
  run: CliRun,
  schema: ZodType<T>,
  tags: Map<string, string>,
): { ok: true; output: T } | { ok: false; errorClass: GatewayErrorClass; message: string } {
  if (run.timedOut)
    return { ok: false, errorClass: 'timeout', message: 'Claude did not answer in time' }
  if (run.code !== 0) {
    const text = `${run.stdout}\n${run.stderr}`
    if (LIMIT_TEXT.test(text))
      return { ok: false, errorClass: 'limit_reached', message: text.trim().slice(0, 300) }
    if (AUTH_TEXT.test(text))
      return { ok: false, errorClass: 'not_connected', message: text.trim().slice(0, 300) }
    return { ok: false, errorClass: 'cli_failed', message: text.trim().slice(0, 300) }
  }
  let parsed: { structured_output?: unknown }
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    return { ok: false, errorClass: 'bad_output', message: 'CLI output is not JSON' }
  }
  if (parsed.structured_output === undefined) {
    return { ok: false, errorClass: 'bad_output', message: 'no structured_output' }
  }
  // The answer is checked with the real values back in it: that is the answer the caller gets.
  const checked = schema.safeParse(restore(parsed.structured_output, tags))
  if (!checked.success)
    return { ok: false, errorClass: 'bad_output', message: checked.error.message.slice(0, 300) }
  return { ok: true, output: checked.data }
}

/**
 * Calls Claude roles through `claude -p` on the subscription, at most `concurrency` at once, P0 first. While the
 * subscription limit holds, P1-P3 calls wait for its end and P0 calls go at once (FR-OPS-3).
 */
export function createGateway(d: {
  db: Db
  secrets: SecretStore
  claudeBin: string
  rolesDir: string
  dataDir: string
  concurrency?: number
  extraEnv?: Record<string, string> | (() => Record<string, string>)
  /** Boris hears of the limit's start and end; without it the gateway keeps quiet. */
  notifier?: Pick<Notifier, 'sendText'>
  limit?: { probeEveryMs?: number; maxWaitMs?: number }
}): Gateway & { stop(): void } {
  const slots = createSlots(d.concurrency ?? 2)
  const maxWaitMs = d.limit?.maxWaitMs ?? 6 * 60 * MINUTE_MS
  const notice = createLimitNotice(async (text) => d.notifier?.sendText(text))
  // Each model meets the limit on its own: Boris's own Opus use may spend Opus while haiku still answers. A model's
  // limit is learnt only from its own answer and ended only by its own probe or call.
  const guards = Object.fromEntries(
    MODELS.map((model) => [
      model,
      createLimitGuard({
        onChange: notice,
        probe: () => call('probe', 'Проверка связи.', ProbeOutput, { model }),
        probeEveryMs: d.limit?.probeEveryMs ?? 10 * MINUTE_MS,
        maxWaitMs,
      }),
    ]),
  ) as Record<Model, LimitGuard>

  // A limit that held when the core stopped holds on: each model's last word decides. Read at once, so Boris hears of
  // the end even when no call comes.
  const limitRead = (async () => {
    const rows = await d.db
      .selectDistinctOn([modelCall.model], {
        model: modelCall.model,
        errorClass: modelCall.errorClass,
      })
      .from(modelCall)
      .where(
        or(eq(modelCall.ok, true), inArray(modelCall.errorClass, ['limit_reached', 'bad_output'])),
      )
      .orderBy(modelCall.model, desc(modelCall.startedAt))
    const byModel: Partial<Record<string, LimitGuard>> = guards
    for (const r of rows) if (r.errorClass === 'limit_reached') byModel[r.model]?.adopt()
  })().catch((e) => {
    console.error('model_call not read', e instanceof Error ? e.message : e)
  })

  /** One run of the CLI, or the reason it did not run. */
  async function runOnce(
    meta: RoleMeta,
    promptPath: string,
    hidden: Redacted,
    schema: ZodType,
    waits: boolean,
  ): Promise<{ result: Outcome; durationMs: number } | 'limit_began'> {
    const guard = guards[meta.model]
    // Whitespace is never part of a token (one saved before the wizard cleaned it may carry a line break).
    const token = (await d.secrets.get('claude_oauth_token'))?.replace(/\s+/g, '') || null
    if (!token)
      return {
        result: { ok: false, errorClass: 'not_connected', message: 'no Claude token' },
        durationMs: 0,
      }
    await slots.acquire(meta.priority)
    try {
      // The limit began while this call stood in the queue: it waits again instead of spending a run.
      if (waits && guard.active()) return 'limit_began'
      const cwd = join(d.dataDir, 'claude-cwd')
      await mkdir(cwd, { recursive: true })
      const ranAt = Date.now()
      const run = await runClaude({
        bin: d.claudeBin,
        args: buildClaudeArgs(meta, promptPath, roleJsonSchema(schema)),
        input: hidden.text,
        token,
        cwd,
        timeoutMs: meta.timeoutMs,
        extraEnv: typeof d.extraEnv === 'function' ? d.extraEnv() : d.extraEnv,
      })
      const result = classify(run, schema, hidden.tags)
      if (!result.ok && result.errorClass === 'limit_reached')
        guard.hit(parseResetAt(`${run.stdout}\n${run.stderr}`, new Date()), ranAt)
      else if (result.ok || result.errorClass === 'bad_output') guard.answered(ranAt)
      return { result, durationMs: run.durationMs }
    } finally {
      slots.release()
    }
  }

  type Call = { role: RoleName; meta: RoleMeta; opts?: CallOptions; hidden: Redacted }

  async function record(
    { role, meta, opts, hidden }: Call,
    startedAt: string,
    result: Outcome,
    durationMs: number,
    waitedMs: number,
  ): Promise<RoleCallResult<unknown>> {
    const id = newEventId()
    await d.db.insert(modelCall).values({
      id,
      role,
      roleVersion: meta.version,
      model: meta.model,
      priority: meta.priority,
      startedAt,
      durationMs,
      ok: result.ok,
      errorClass: result.ok ? null : result.errorClass,
      pseudonymized: true,
    })
    const redacted = Object.values(hidden.counts).some((n) => n > 0)
      ? { redacted: hidden.counts }
      : {}
    await appendEvent(d.db, {
      type: result.ok ? 'model.called' : 'model.failed',
      v: 1,
      entity: { kind: 'model_call', id },
      account_id: null,
      actor: 'sara',
      occurred_at: startedAt,
      causation_id: opts?.causationId ?? null,
      correlation_id: opts?.correlationId ?? newEventId(),
      reason: result.ok ? null : result.errorClass,
      payload: {
        role,
        durationMs,
        ...(result.ok ? {} : { errorClass: result.errorClass }),
        ...(waitedMs > 0 ? { waitedMs } : {}),
        ...redacted,
      },
    })
    return result.ok
      ? { ok: true, output: result.output, durationMs, modelCallId: id }
      : { ...result, durationMs, modelCallId: id }
  }

  async function call<T>(
    role: RoleName,
    input: string,
    schema: ZodType<T>,
    opts?: CallOptions,
  ): Promise<RoleCallResult<T>> {
    const loaded = await loadRole(d.rolesDir, role)
    const promptPath = loaded.promptPath
    const meta = opts?.model
      ? { ...loaded.meta, model: opts.model, fallbackModel: undefined }
      : loaded.meta
    await limitRead
    const guard = guards[meta.model]
    // Always on: what the model sees has no phone, e-mail, link or given name of a client (ADR-016).
    const c: Call = { role, meta, opts, hidden: redact(input, opts?.redact?.names) }
    const waits = meta.priority !== 'P0'
    const calledAt = new Date()
    const deadline = calledAt.getTime() + (opts?.limitWaitMs ?? maxWaitMs)
    let waitedMs = 0
    let last: RoleCallResult<unknown> | null = null
    for (;;) {
      if (waits && guard.active()) {
        const before = Date.now()
        const turn = await guard.wait(deadline)
        waitedMs += Date.now() - before
        if (turn === 'expired') {
          // The limit outlived the wait: the last run's answer stands, or one without a run is recorded.
          last ??= await record(
            c,
            calledAt.toISOString(),
            { ok: false, errorClass: 'limit_reached', message: 'the Claude limit still holds' },
            0,
            waitedMs,
          )
          return last as RoleCallResult<T>
        }
      }
      // A run is dated when it starts, not when its call began to wait out a limit.
      const startedAt = new Date().toISOString()
      const run = await runOnce(meta, promptPath, c.hidden, schema, waits)
      if (run === 'limit_began') continue
      last = await record(c, startedAt, run.result, run.durationMs, waitedMs)
      if (!waits || run.result.ok || run.result.errorClass !== 'limit_reached')
        return last as RoleCallResult<T>
    }
  }

  return {
    call,
    stop() {
      for (const g of Object.values(guards)) g.stop()
    },
  }
}

/** The same gateway for jobs that must not stand still through a limit: P1-P3 meet it with limit_reached at once. */
export function withoutLimitWait(gw: Gateway): Gateway {
  return {
    call: (role, input, schema, opts) => gw.call(role, input, schema, { ...opts, limitWaitMs: 0 }),
  }
}
