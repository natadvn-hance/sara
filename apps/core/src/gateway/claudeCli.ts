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

/**
 * The CLI contract for a role call (spec 7.4). `--max-turns` is not used: CLI 2.1.308 no longer lists it. A role
 * without tools gets none (`--tools ""`). A role that names built-in tools (ADR-027, amendment of 07.11.2026: only
 * WebSearch and WebFetch) gets exactly those, allowed by name, and answers as a stream of events, so the gateway can
 * see which pages the run really got.
 */
export function buildClaudeArgs(meta: RoleMeta, promptPath: string, jsonSchema: object): string[] {
  const tools = meta.tools ?? []
  return [
    '-p',
    '--model',
    meta.model,
    ...(meta.fallbackModel ? ['--fallback-model', meta.fallbackModel] : []),
    ...(meta.effort ? ['--effort', meta.effort] : []),
    '--system-prompt-file',
    promptPath,
    '--output-format',
    ...(tools.length > 0 ? ['stream-json', '--verbose'] : ['json']),
    '--json-schema',
    JSON.stringify(jsonSchema),
    '--tools',
    tools.join(','),
    ...(tools.length > 0 ? ['--allowedTools', ...tools] : []),
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--no-session-persistence',
    ...(meta.maxBudgetUsd ? ['--max-budget-usd', String(meta.maxBudgetUsd)] : []),
  ]
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\)\]}]+/g

/**
 * The answer of a run with `--output-format stream-json`: the last result event, as `--output-format json` prints it,
 * and every link the tools gave the run back (search results, fetched pages). Links the model only wrote itself are
 * not in it: a page is «seen» when a tool's result holds it. Null when no result event is there.
 */
export function readStream(stdout: string): { result: string; seen: string[] } | null {
  let result: string | null = null
  const seen = new Set<string>()
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let o: { type?: string; message?: { content?: unknown }; tool_use_result?: unknown }
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    if (o.type === 'result') result = t
    if (o.type !== 'user') continue
    const text = `${JSON.stringify(o.message?.content ?? '')}\n${JSON.stringify(o.tool_use_result ?? '')}`
    for (const m of text.match(URL_IN_TEXT) ?? []) seen.add(m.replace(/[.,;:!?]+$/, ''))
  }
  return result === null ? null : { result, seen: [...seen] }
}

/**
 * A link as one page: no fragment, no utm marks, no «www.», no trailing slash, the scheme and the host in lower case.
 * Two links to the same page compare equal.
 */
export function samePage(url: string): string | null {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  u.hash = ''
  for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k)
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname.replace(/\/+$/, '')
  const query = u.searchParams.toString()
  return `${host}${path}${query ? `?${query}` : ''}`
}

/**
 * The CLI contract for a conversation turn (ADR-027): a text answer, no built-in tool (no files, commands or web),
 * and only the MCP server `server` of the config file, each of its `tools` allowed by name without a prompt.
 */
export function buildConverseArgs(
  meta: RoleMeta,
  promptPath: string,
  mcp: { configPath: string; server: string; tools: string[] },
  maxBudgetUsd?: number,
): string[] {
  // Built-in tools only for a role that names them in its meta (the topic chat: ADR-027 point 7); none by default.
  const builtinTools: string[] = meta.tools ?? []
  return [
    '-p',
    '--model',
    meta.model,
    ...(meta.effort ? ['--effort', meta.effort] : []),
    '--system-prompt-file',
    promptPath,
    '--output-format',
    'json',
    '--tools',
    builtinTools.join(','),
    '--mcp-config',
    mcp.configPath,
    '--strict-mcp-config',
    '--allowedTools',
    ...builtinTools,
    ...mcp.tools.map((t) => `mcp__${mcp.server}__${t}`),
    '--setting-sources',
    'project',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--no-session-persistence',
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : []),
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
