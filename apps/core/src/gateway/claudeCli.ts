import { spawn } from 'node:child_process'
import type { RoleMeta } from '@sara/shared'
import { type ZodType, z } from 'zod'

/**
 * JSON Schema of a role's answer for `--json-schema`. Zod marks it as draft 2020-12, which the
 * CLI's validator does not know (checked on CLI 2.1.309), so the marker is dropped.
 */
export function roleJsonSchema(schema: ZodType): object {
  const { $schema: _draft, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

/** The CLI contract for a role call (spec 7.4). `--max-turns` is not used: CLI 2.1.308 no longer lists it. */
export function buildClaudeArgs(meta: RoleMeta, promptPath: string, jsonSchema: object): string[] {
  return [
    '-p',
    '--model',
    meta.model,
    ...(meta.fallbackModel ? ['--fallback-model', meta.fallbackModel] : []),
    '--system-prompt-file',
    promptPath,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(jsonSchema),
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--no-session-persistence',
  ]
}

export type CliRun = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

export function runClaude(o: {
  bin: string
  args: string[]
  input: string
  token: string
  cwd: string
  timeoutMs: number
  extraEnv?: Record<string, string>
}): Promise<CliRun> {
  const started = Date.now()
  return new Promise((done) => {
    const child = spawn(o.bin, o.args, {
      cwd: o.cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        CLAUDE_CODE_OAUTH_TOKEN: o.token,
        ...o.extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, o.timeoutMs)
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString()
    })
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString()
    })
    child.on('error', (e) => {
      stderr += String(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr, timedOut, durationMs: Date.now() - started })
    })
    // A CLI that dies before reading its input must not crash the core (EPIPE).
    child.stdin.on('error', (e) => {
      stderr += `stdin: ${String(e)}`
    })
    child.stdin.end(o.input)
  })
}
