import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProbeOutput } from '@sara/shared'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildClaudeArgs } from '../src/gateway/claudeCli'
import { createGateway } from '../src/gateway/gateway'
import { createSecretStore } from '../src/secrets/store'
import { openTestDb, resetDb } from './helpers/db'

const ROOT = resolve(import.meta.dirname, '../../..')
const FAKE = join(ROOT, 'tests/fakes/fake-claude.mjs')
const { db, close } = openTestDb()
afterAll(close)

let dir: string
let log: string
beforeEach(async () => {
  await resetDb(db)
  dir = await mkdtemp(join(tmpdir(), 'gw-'))
  log = join(dir, 'calls.log')
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
})

async function gateway(env: Record<string, string>, withToken = true) {
  const secrets = createSecretStore(join(dir, 'data'))
  if (withToken) await secrets.set('claude_oauth_token', 'tok')
  return createGateway({
    db,
    secrets,
    claudeBin: FAKE,
    rolesDir: join(dir, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: { FAKE_CLAUDE_ARGS_LOG: log, ...env },
  })
}

async function calls(): Promise<{ args: string[]; start: number; end: number; token: string }[]> {
  try {
    return (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

const countRows = async () =>
  (await db.execute<{ n: number }>(sql`select count(*)::int as n from core.model_call`)).rows[0]?.n

describe('model gateway', () => {
  it('LLM-3: builds the exact CLI contract with tools disabled', () => {
    const meta = {
      name: 'probe',
      version: 1,
      model: 'haiku',
      priority: 'P0',
      timeoutMs: 30000,
    } as const
    expect(buildClaudeArgs(meta, '/r/probe/role.md', { type: 'object' })).toEqual([
      '-p',
      '--model',
      'haiku',
      '--system-prompt-file',
      '/r/probe/role.md',
      '--output-format',
      'json',
      '--json-schema',
      '{"type":"object"}',
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
    ])
  })

  it('FR-SET-3: returns validated structured output and records model_call', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_OUTPUT: '{"ok":true}' })
    const r = await gw.call('probe', 'проверка', ProbeOutput)
    expect(r).toMatchObject({ ok: true, output: { ok: true } })
    expect(await countRows()).toBe(1)
    expect((await calls())[0]?.token).toBe('tok')
  })

  it('LLM-3: missing structured_output is bad_output, not an empty answer', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'no_structured' })
    expect(await gw.call('probe', 'x', ProbeOutput)).toMatchObject({
      ok: false,
      errorClass: 'bad_output',
    })
  })

  it('LLM-3: output that breaks the schema is bad_output', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_OUTPUT: '{"ok":false}' })
    expect(await gw.call('probe', 'x', ProbeOutput)).toMatchObject({
      ok: false,
      errorClass: 'bad_output',
    })
  })

  it('FR-SET-3: no token gives not_connected without spawning the CLI', async () => {
    const gw = await gateway({}, false)
    expect(await gw.call('probe', 'x', ProbeOutput)).toMatchObject({
      ok: false,
      errorClass: 'not_connected',
    })
    expect(await calls()).toHaveLength(0)
  })

  it('FR-OPS-3: limit text gives limit_reached', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'limit' })
    expect(await gw.call('probe', 'x', ProbeOutput)).toMatchObject({
      ok: false,
      errorClass: 'limit_reached',
    })
  })

  it('LLM-1: other CLI failure gives cli_failed', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'exit1' })
    expect(await gw.call('probe', 'x', ProbeOutput)).toMatchObject({
      ok: false,
      errorClass: 'cli_failed',
    })
  })

  it('LLM-1: timeout kills the CLI and reports timeout', async () => {
    const meta = JSON.parse(await readFile(join(dir, 'roles/probe/meta.json'), 'utf8'))
    await writeFile(join(dir, 'roles/probe/meta.json'), JSON.stringify({ ...meta, timeoutMs: 500 }))
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'hang' })
    const r = await gw.call('probe', 'x', ProbeOutput)
    expect(r).toMatchObject({ ok: false, errorClass: 'timeout' })
    expect(r.durationMs).toBeLessThan(5000)
  })

  it('LLM-1: runs at most two calls at once', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'sleep', FAKE_CLAUDE_SLEEP_MS: '400' })
    await Promise.all(Array.from({ length: 5 }, () => gw.call('probe', 'x', ProbeOutput)))
    const c = await calls()
    expect(c).toHaveLength(5)
    const maxOverlap = Math.max(
      ...c.map((a) => c.filter((b) => b.start < a.end && a.start < b.end).length),
    )
    expect(maxOverlap).toBeLessThanOrEqual(2)
  })
})
