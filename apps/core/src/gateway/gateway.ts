import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MODELS, newEventId, ProbeOutput, type RoleMeta } from '@sara/shared'
import { and, desc, eq, gt, or, sql } from 'drizzle-orm'
import { type ZodType, z } from 'zod'
import type { Db } from '../db/client'
import { event, modelCall } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { Notifier } from '../notify/notifier'
import type { SecretStore } from '../secrets/store'
import {
  buildClaudeArgs,
  buildConverseArgs,
  type CliRun,
  readStream,
  roleJsonSchema,
  runClaude,
} from './claudeCli'
import { createLimitGuard, createLimitNotice, type LimitGuard, parseResetAt } from './limit'
import { createSlots } from './queue'
import { type Redacted, type Redactor, redact, restore } from './redact'
import { loadRole, type RoleName } from './roles'

export type GatewayErrorClass =
  | 'not_connected'
  | 'timeout'
  | 'bad_output'
  | 'cli_failed'
  | 'limit_reached'

export type RoleCallResult<T> =
  | {
      ok: true
      output: T
      durationMs: number
      modelCallId: string
      /** A role with web tools: every link its tools gave the run (search results, fetched pages). */
      sources?: string[]
    }
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
  /** This call's priority instead of the role's: a trial run asks for P3 so live work goes first. */
  priority?: RoleMeta['priority']
  /** How long a P1-P3 call may wait out the Claude limit (default 6 hours); 0 meets it with limit_reached at once. */
  limitWaitMs?: number
  /**
   * Client names to hide from the model, besides the phones, e-mails and links it never sees (ADR-016). A call whose
   * input carries a client's words passes it, with the names it knows (an empty list when it knows none): without a
   * name in it the call is not recorded as pseudonymized, because a name inside the text went through. With
   * `restore: false` the tags stay in the answer as the model wrote them: for an answer that is kept (the rules
   * proposal) and must never hold a client's value.
   */
  redact?: { names?: (string | null | undefined)[]; restore?: boolean }
}

export type Gateway = {
  call<T>(
    role: RoleName,
    input: string,
    schema: ZodType<T>,
    opts?: CallOptions,
  ): Promise<RoleCallResult<T>>
}

/** A conversation turn (ADR-027): the role answers in words and may use the tools of one MCP server. */
export type ConverseOptions = {
  /**
   * The turn's hiding of client data (ADR-016), shared with the tools: the input goes through it, and the answer is
   * restored by it, with the tags the tools' answers added during the run.
   */
  redactor: Redactor
  /** The MCP config file the CLI loads, its server's name and the tools allowed: no other tool exists for the run. */
  mcp: { configPath: string; server: string; tools: string[] }
  correlationId?: string
  /** A run that would spend more stops (`--max-budget-usd`): a loop of tools never eats the subscription. */
  maxBudgetUsd?: number
}

export type ConverseResult =
  | { ok: true; text: string; durationMs: number; modelCallId: string }
  | {
      ok: false
      errorClass: GatewayErrorClass
      message: string
      durationMs: number
      modelCallId: string
      /** limit_reached: when the limit ends, if a CLI answer said. */
      resetAt: Date | null
    }

export type Converse = (
  role: RoleName,
  input: string,
  o: ConverseOptions,
) => Promise<ConverseResult>

const MINUTE_MS = 60_000
/** How far back the journal is read for a limit: the answers of one model since its last good one. */
const LIMIT_HISTORY = 500
type Model = RoleMeta['model']

type Outcome =
  | { ok: true; output: unknown; sources?: string[] }
  | { ok: false; errorClass: GatewayErrorClass; message: string; resetAt?: string }

/** The subscription limit only: "Context limit reached" and the like are other failures. */
const LIMIT_TEXT =
  /usage limit|rate limit|hit your (?:[\w'-]+ )*limit|(?:session|weekly|spend|\d+-hour) limit reached/i
const AUTH_TEXT = /failed to authenticate|invalid api key|oauth|not logged in|please run \/login/i

function classify<T>(
  run: CliRun,
  schema: ZodType<T>,
  tags: Map<string, string>,
  stream = false,
):
  | { ok: true; output: T; sources?: string[] }
  | { ok: false; errorClass: GatewayErrorClass; message: string } {
  const failed = failureOf(run)
  if (failed) return { ok: false, ...failed }
  // A role with tools answers as a stream of events: its last result event is the answer.
  const read = stream ? readStream(run.stdout) : null
  if (stream && !read) return { ok: false, errorClass: 'bad_output', message: 'no result event' }
  let parsed: { structured_output?: unknown }
  try {
    parsed = JSON.parse(read ? read.result : run.stdout)
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
  return { ok: true, output: checked.data, ...(read && { sources: read.seen }) }
}

/** The failure of a run by its exit, the same for both kinds of call. */
function failureOf(run: CliRun): { errorClass: GatewayErrorClass; message: string } | null {
  if (run.timedOut) return { errorClass: 'timeout', message: 'Claude did not answer in time' }
  if (run.code === 0) return null
  const text = `${run.stdout}\n${run.stderr}`
  if (LIMIT_TEXT.test(text))
    return { errorClass: 'limit_reached', message: text.trim().slice(0, 300) }
  if (AUTH_TEXT.test(text))
    return { errorClass: 'not_connected', message: text.trim().slice(0, 300) }
  return { errorClass: 'cli_failed', message: text.trim().slice(0, 300) }
}

/** A conversation turn's answer: the words of the result, or why there are none (a stop on the budget is one). */
function classifyText(
  run: CliRun,
):
  | { ok: true; text: string; costUsd: number | null; turns: number | null }
  | (Outcome & { ok: false }) {
  const failed = failureOf(run)
  if (failed) return { ok: false, ...failed }
  let parsed: {
    subtype?: string
    is_error?: boolean
    result?: unknown
    total_cost_usd?: number
    num_turns?: number
  }
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    return { ok: false, errorClass: 'bad_output', message: 'CLI output is not JSON' }
  }
  const words = typeof parsed.result === 'string' ? parsed.result.trim() : ''
  if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
    const message = `${parsed.subtype ?? 'error'}: ${words}`.slice(0, 300)
    if (LIMIT_TEXT.test(words)) return { ok: false, errorClass: 'limit_reached', message }
    return { ok: false, errorClass: 'cli_failed', message }
  }
  if (!words) return { ok: false, errorClass: 'bad_output', message: 'no result text' }
  return {
    ok: true,
    text: words,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
    turns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
  }
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
}): Gateway & { converse: Converse; stop(): void } {
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

  // A limit that held when the core stopped holds on: each model's last word decides, and the journal gives back
  // when the limit began and the last reset time it named. Read at once, so Boris hears of the end even when no
  // call comes.
  const limitRead = Promise.all(
    MODELS.map(async (model) => {
      const rows = await d.db
        .select({
          errorClass: modelCall.errorClass,
          at: sql<number>`(extract(epoch from ${modelCall.startedAt}) * 1000)::float8`,
          resetAt: sql<string | null>`${event.payload}->>'resetAt'`,
        })
        .from(modelCall)
        .leftJoin(
          event,
          and(
            eq(event.entityKind, 'model_call'),
            sql`${event.entityId} = ${modelCall.id}::text`,
            eq(event.type, 'model.failed'),
          ),
        )
        .where(
          and(
            eq(modelCall.model, model),
            or(
              eq(modelCall.ok, true),
              eq(modelCall.errorClass, 'bad_output'),
              // A limit answer of a real run; a wait that ran out writes a stand-in row (0 ms) that says nothing.
              and(eq(modelCall.errorClass, 'limit_reached'), gt(modelCall.durationMs, 0)),
            ),
          ),
        )
        .orderBy(desc(modelCall.startedAt))
        .limit(LIMIT_HISTORY)
      // The newest rows are limit answers back to the last answer: that run of them is this limit.
      const end = rows.findIndex((r) => r.errorClass !== 'limit_reached')
      const held = end < 0 ? rows : rows.slice(0, end)
      const began = held.at(-1)
      if (!began) return
      const reset = held.find((r) => r.resetAt)?.resetAt
      guards[model].adopt(Number(began.at), reset ? new Date(reset) : null)
    }),
  ).catch((e) => {
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
      const result = classify(run, schema, hidden.tags, (meta.tools?.length ?? 0) > 0)
      if (!result.ok && result.errorClass === 'limit_reached') {
        const resetAt = parseResetAt(`${run.stdout}\n${run.stderr}`, new Date())
        guard.hit(resetAt, ranAt)
        // The reset time goes into the journal: after a restart it is all the core has of this limit.
        return {
          result: { ...result, ...(resetAt && { resetAt: resetAt.toISOString() }) },
          durationMs: run.durationMs,
        }
      }
      if (result.ok || result.errorClass === 'bad_output') guard.answered(ranAt)
      return { result, durationMs: run.durationMs }
    } finally {
      slots.release(meta.priority)
    }
  }

  type Call = { role: RoleName; meta: RoleMeta; opts?: CallOptions; hidden: Redacted }

  async function record(
    { role, meta, opts, hidden }: Call,
    startedAt: string,
    result: Outcome,
    durationMs: number,
    waitedMs: number,
    extra: Record<string, unknown> = {},
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
      // A call without the option carries no client's words (the probe); one with it is pseudonymized only if it had a name to look for.
      pseudonymized: opts?.redact === undefined || hidden.named,
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
        ...(!result.ok && result.resetAt ? { resetAt: result.resetAt } : {}),
        ...(waitedMs > 0 ? { waitedMs } : {}),
        // Numbers only: how many pages the tools gave a role with web search.
        ...(result.ok && result.sources ? { sources: result.sources.length } : {}),
        ...redacted,
        ...extra,
      },
    })
    if (result.ok)
      return {
        ok: true,
        output: result.output,
        durationMs,
        modelCallId: id,
        ...(result.sources && { sources: result.sources }),
      }
    const { resetAt: _, ...failure } = result
    return { ...failure, durationMs, modelCallId: id }
  }

  async function call<T>(
    role: RoleName,
    input: string,
    schema: ZodType<T>,
    opts?: CallOptions,
  ): Promise<RoleCallResult<T>> {
    const loaded = await loadRole(d.rolesDir, role)
    const promptPath = loaded.promptPath
    const meta: RoleMeta = {
      ...loaded.meta,
      ...(opts?.model ? { model: opts.model, fallbackModel: undefined } : {}),
      ...(opts?.priority ? { priority: opts.priority } : {}),
    }
    await limitRead
    const guard = guards[meta.model]
    // Always on: what the model sees has no phone, e-mail, link or given name of a client (ADR-016).
    const hidden = redact(input, opts?.redact?.names)
    // Tags the answer may not get back stay tags: the run restores only what its tag map knows.
    const c: Call = {
      role,
      meta,
      opts,
      hidden: opts?.redact?.restore === false ? { ...hidden, tags: new Map() } : hidden,
    }
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

  /**
   * One conversation turn (ADR-027). Boris waits in the chat, so a limit is never waited out: while it holds the turn
   * does not run and the answer says when it ends. The run takes a slot like any call, P0 first.
   */
  async function converse(
    role: RoleName,
    input: string,
    o: ConverseOptions,
  ): Promise<ConverseResult> {
    const { meta, promptPath } = await loadRole(d.rolesDir, role)
    await limitRead
    const guard = guards[meta.model]
    const c: Call = {
      role,
      meta,
      opts: { correlationId: o.correlationId, redact: {} },
      hidden: {
        text: o.redactor.hide(input),
        tags: o.redactor.tags,
        counts: o.redactor.counts,
        named: o.redactor.named,
      },
    }
    const failed = async (
      startedAt: string,
      result: Outcome & { ok: false },
      durationMs: number,
      resetAt: Date | null,
    ): Promise<ConverseResult> => {
      const r = await record(c, startedAt, result, durationMs, 0)
      return {
        ok: false,
        errorClass: result.errorClass,
        message: result.message,
        durationMs,
        modelCallId: r.modelCallId,
        resetAt,
      }
    }
    if (guard.active())
      return failed(
        new Date().toISOString(),
        { ok: false, errorClass: 'limit_reached', message: 'the Claude limit still holds' },
        0,
        guard.resetAt(),
      )
    const token = (await d.secrets.get('claude_oauth_token'))?.replace(/\s+/g, '') || null
    if (!token)
      return failed(
        new Date().toISOString(),
        { ok: false, errorClass: 'not_connected', message: 'no Claude token' },
        0,
        null,
      )
    await slots.acquire(meta.priority)
    const startedAt = new Date().toISOString()
    const ranAt = Date.now()
    let run: CliRun
    try {
      const cwd = join(d.dataDir, 'claude-cwd')
      await mkdir(cwd, { recursive: true })
      run = await runClaude({
        bin: d.claudeBin,
        args: buildConverseArgs(meta, promptPath, o.mcp, o.maxBudgetUsd),
        input: c.hidden.text,
        token,
        cwd,
        timeoutMs: meta.timeoutMs,
        extraEnv: typeof d.extraEnv === 'function' ? d.extraEnv() : d.extraEnv,
      })
    } finally {
      slots.release(meta.priority)
    }
    const out = classifyText(run)
    if (!out.ok && out.errorClass === 'limit_reached') {
      const resetAt = parseResetAt(`${run.stdout}\n${run.stderr}`, new Date())
      guard.hit(resetAt, ranAt)
      return failed(
        startedAt,
        { ...out, ...(resetAt && { resetAt: resetAt.toISOString() }) },
        run.durationMs,
        resetAt,
      )
    }
    if (out.ok || out.errorClass === 'bad_output') guard.answered(ranAt)
    if (!out.ok) return failed(startedAt, out, run.durationMs, null)
    const r = await record(c, startedAt, { ok: true, output: null }, run.durationMs, 0, {
      ...(out.costUsd !== null && { costUsd: out.costUsd }),
      ...(out.turns !== null && { turns: out.turns }),
    })
    return {
      ok: true,
      text: restore(out.text, o.redactor.tags),
      durationMs: run.durationMs,
      modelCallId: r.modelCallId,
    }
  }

  return {
    call,
    converse,
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
