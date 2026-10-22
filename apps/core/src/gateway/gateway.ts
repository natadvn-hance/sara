import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { newEventId } from '@sara/shared'
import { type ZodType, z } from 'zod'
import type { Db } from '../db/client'
import { modelCall } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { SecretStore } from '../secrets/store'
import { buildClaudeArgs, type CliRun, runClaude } from './claudeCli'
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

export type Gateway = {
  call<T>(
    role: RoleName,
    input: string,
    schema: ZodType<T>,
    opts?: { correlationId?: string; causationId?: string },
  ): Promise<RoleCallResult<T>>
}

const LIMIT_TEXT = /usage limit|rate limit/i
const AUTH_TEXT = /failed to authenticate|invalid api key|oauth|not logged in|please run \/login/i

function classify<T>(
  run: CliRun,
  schema: ZodType<T>,
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
  const checked = schema.safeParse(parsed.structured_output)
  if (!checked.success)
    return { ok: false, errorClass: 'bad_output', message: checked.error.message.slice(0, 300) }
  return { ok: true, output: checked.data }
}

/** Calls Claude roles through `claude -p` on the subscription, at most `concurrency` at once. */
export function createGateway(d: {
  db: Db
  secrets: SecretStore
  claudeBin: string
  rolesDir: string
  dataDir: string
  concurrency?: number
  extraEnv?: Record<string, string>
}): Gateway {
  const limit = d.concurrency ?? 2
  let running = 0
  const waiting: (() => void)[] = []

  async function acquire(): Promise<void> {
    if (running < limit) {
      running++
      return
    }
    await new Promise<void>((r) => waiting.push(r))
  }
  function release(): void {
    const next = waiting.shift()
    if (next) next()
    else running--
  }

  return {
    async call(role, input, schema, opts) {
      const { meta, promptPath } = await loadRole(d.rolesDir, role)
      const id = newEventId()
      const startedAt = new Date().toISOString()
      const token = await d.secrets.get('claude_oauth_token')
      let result:
        | { ok: true; output: unknown }
        | { ok: false; errorClass: GatewayErrorClass; message: string }
      let durationMs = 0
      if (!token) {
        result = { ok: false, errorClass: 'not_connected', message: 'no Claude token' }
      } else {
        await acquire()
        try {
          const cwd = join(d.dataDir, 'claude-cwd')
          await mkdir(cwd, { recursive: true })
          const run = await runClaude({
            bin: d.claudeBin,
            args: buildClaudeArgs(meta, promptPath, z.toJSONSchema(schema)),
            input,
            token,
            cwd,
            timeoutMs: meta.timeoutMs,
            extraEnv: d.extraEnv,
          })
          durationMs = run.durationMs
          result = classify(run, schema)
        } finally {
          release()
        }
      }
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
      })
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
        payload: { role, durationMs, ...(result.ok ? {} : { errorClass: result.errorClass }) },
      })
      return result.ok
        ? { ok: true, output: result.output as never, durationMs, modelCallId: id }
        : { ...result, durationMs, modelCallId: id }
    },
  }
}
