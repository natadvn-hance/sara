import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProbeOutput, ScorerOutput, SorterOutput } from '@sara/shared'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { modelCall } from '../src/db/schema'
import { buildClaudeArgs, roleJsonSchema } from '../src/gateway/claudeCli'
import { createGateway, withoutLimitWait } from '../src/gateway/gateway'
import { LIMIT_TEXTS } from '../src/gateway/limit'
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

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

/** `env` is read on every CLI run, so a test can end the limit by changing it. */
async function gateway(
  env: Record<string, string>,
  withToken = true,
  more: {
    sent?: string[]
    concurrency?: number
    limit?: { probeEveryMs?: number; maxWaitMs?: number }
  } = {},
) {
  const secrets = createSecretStore(join(dir, 'data'))
  if (withToken) await secrets.set('claude_oauth_token', 'tok')
  const gw = createGateway({
    db,
    secrets,
    claudeBin: FAKE,
    rolesDir: join(dir, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: () => ({ FAKE_CLAUDE_ARGS_LOG: log, ...env }),
    notifier: more.sent
      ? {
          sendText: async (t) => {
            more.sent?.push(t)
            return { messageId: 1 }
          },
        }
      : undefined,
    limit: more.limit,
    concurrency: more.concurrency,
  })
  stops.push(gw.stop)
  return gw
}

const roleOf = (c: { args: string[] }) =>
  /roles\/([^/]+)\/role\.md$/.exec(c.args[c.args.indexOf('--system-prompt-file') + 1] ?? '')?.[1]

async function until(check: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function calls(): Promise<
  { args: string[]; stdin: string; start: number; end: number; token: string }[]
> {
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

  it('LLM-3: the answer schema has no $schema draft marker the CLI cannot read', () => {
    const schema = roleJsonSchema(ProbeOutput)
    expect(schema).not.toHaveProperty('$schema')
    expect(schema).toMatchObject({ type: 'object', required: ['ok'] })
  })

  it('FR-SET-3: returns validated structured output and records model_call', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_OUTPUT: '{"ok":true}' })
    const r = await gw.call('probe', 'проверка', ProbeOutput)
    expect(r).toMatchObject({ ok: true, output: { ok: true } })
    expect(await countRows()).toBe(1)
    expect((await calls())[0]?.token).toBe('tok')
  })

  it('FR-SET-3: a token saved with a line break inside reaches the CLI without it', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_OUTPUT: '{"ok":true}' })
    await createSecretStore(join(dir, 'data')).set('claude_oauth_token', 'to\nk ')
    await gw.call('probe', 'x', ProbeOutput)
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

  it('FR-SET-3: expired or wrong token reported by the CLI gives not_connected', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'auth_error' })
    expect(await gw.call('probe', 'x', ProbeOutput)).toMatchObject({
      ok: false,
      errorClass: 'not_connected',
    })
  })

  it('FR-OPS-3: limit text gives limit_reached', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'limit' })
    expect(await gw.call('probe', 'x', ProbeOutput)).toMatchObject({
      ok: false,
      errorClass: 'limit_reached',
    })
  })

  it('FR-OPS-3: the CLI\'s "You\'ve hit your weekly limit" answer is limit_reached', async () => {
    const gw = await gateway({
      FAKE_CLAUDE_MODE: 'limit_json',
      FAKE_CLAUDE_LIMIT_TEXT: "You've hit your weekly limit · resets 2am (Europe/Moscow)",
    })
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

  it('LLM-1: a CLI that exits without reading its input is cli_failed and does not crash the process', async () => {
    const secrets = createSecretStore(join(dir, 'data'))
    await secrets.set('claude_oauth_token', 'tok')
    const gw = createGateway({
      db,
      secrets,
      claudeBin: '/usr/bin/false',
      rolesDir: join(dir, 'roles'),
      dataDir: join(dir, 'data'),
    })
    expect(await gw.call('probe', 'x'.repeat(200_000), ProbeOutput)).toMatchObject({
      ok: false,
      errorClass: 'cli_failed',
    })
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

  it('FR-ACC-5: a call with a priority override queues behind the same role at its own priority', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'sleep', FAKE_CLAUDE_SLEEP_MS: '300' }, true, {
      concurrency: 1,
    })
    const first = gw.call('scorer', 'first', ProbeOutput)
    await new Promise((r) => setTimeout(r, 100))
    const trial = gw.call('scorer', 'trial', ProbeOutput, { priority: 'P3' })
    const live = gw.call('scorer', 'live', ProbeOutput)
    await Promise.all([first, trial, live])
    const order = (await calls()).sort((a, b) => a.start - b.start).map((c) => c.stdin)
    expect(order).toEqual(['first', 'live', 'trial'])
    const rows = await db.execute<{ priority: string }>(
      sql`select priority from core.model_call order by started_at`,
    )
    expect(rows.rows.map((r) => r.priority)).toEqual(['P2', 'P2', 'P3'])
  })

  it('FR-OPS-3: calls start by role priority when the slots are busy', async () => {
    for (const [role, priority] of [
      ['sorter', 'P1'],
      ['scorer', 'P2'],
      ['rules-proposer', 'P3'],
    ]) {
      const path = join(dir, `roles/${role}/meta.json`)
      await writeFile(
        path,
        JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), priority }),
      )
    }
    const secrets = createSecretStore(join(dir, 'data'))
    await secrets.set('claude_oauth_token', 'tok')
    const gw = createGateway({
      db,
      secrets,
      claudeBin: FAKE,
      rolesDir: join(dir, 'roles'),
      dataDir: join(dir, 'data'),
      concurrency: 1,
      extraEnv: {
        FAKE_CLAUDE_ARGS_LOG: log,
        FAKE_CLAUDE_MODE: 'sleep',
        FAKE_CLAUDE_SLEEP_MS: '300',
      },
    })
    const first = gw.call('scorer', 'x', ProbeOutput)
    await new Promise((r) => setTimeout(r, 100))
    await Promise.all([
      first,
      gw.call('rules-proposer', 'x', ProbeOutput),
      gw.call('scorer', 'x', ProbeOutput),
      gw.call('probe', 'x', ProbeOutput),
      gw.call('sorter', 'x', ProbeOutput),
    ])
    const order = (await calls())
      .sort((a, b) => a.start - b.start)
      .map(
        (c) =>
          /roles\/([^/]+)\/role\.md$/.exec(
            c.args[c.args.indexOf('--system-prompt-file') + 1] ?? '',
          )?.[1],
      )
    expect(order).toEqual(['scorer', 'probe', 'sorter', 'scorer', 'rules-proposer'])
  })

  it('FR-LEAD-3: a call can name its model', async () => {
    // The Sorter has a fallback model: naming the model drops it, the named one is final.
    const gw = await gateway({
      FAKE_CLAUDE_OUTPUT: '{"verdict":"fit","reason":"да","tags":[],"confidence":0.9}',
    })
    const r = await gw.call('sorter', 'Тема: сайт', SorterOutput, { model: 'opus' })
    expect(r.ok).toBe(true)
    const [c] = await calls()
    expect(c?.args[c.args.indexOf('--model') + 1]).toBe('opus')
    expect(c?.args).not.toContain('--fallback-model')
  })
})

describe('client data and the model', () => {
  it('NFR-PRIV-2: the CLI never sees a phone, an e-mail, a link or a given name, and the answer gets them back', async () => {
    const answer = {
      verdict: 'fit',
      reason: 'Позвонить [имя 1] на [телефон 1], [ссылка 7] не трогать',
      tags: ['[почта 1]'],
      confidence: 0.9,
    }
    const gw = await gateway({ FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({ sorter: answer }) })
    const r = await gw.call(
      'sorter',
      'Олег просит сайт, тел. +7 916 123-45-67, почта oleg@mail.ru, пример vk.com/hance',
      SorterOutput,
      { redact: { names: ['Олег'] } },
    )
    expect((await calls())[0]?.stdin).toBe(
      '[имя 1] просит сайт, тел. [телефон 1], почта [почта 1], пример [ссылка 1]',
    )
    expect(r).toMatchObject({
      ok: true,
      output: {
        reason: 'Позвонить Олег на +7 916 123-45-67, [ссылка 7] не трогать',
        tags: ['oleg@mail.ru'],
      },
    })
    const rows = await db.execute<{ pseudonymized: boolean }>(
      sql`select pseudonymized from core.model_call`,
    )
    expect(rows.rows).toEqual([{ pseudonymized: true }])
    const events = await db.execute<{ payload: { redacted?: unknown } }>(
      sql`select payload from core.event where type = 'model.called'`,
    )
    expect(events.rows[0]?.payload.redacted).toEqual({ phone: 1, email: 1, link: 1, name: 1 })
  })
})

describe('an answer that must stay hidden', () => {
  it('NFR-PRIV-2: with restore off the tags of the answer stay as the model wrote them', async () => {
    const gw = await gateway({
      FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
        sorter: {
          verdict: 'fit',
          reason: 'Это [имя 1], тел. [телефон 1]',
          tags: [],
          confidence: 0.9,
        },
      }),
    })
    const r = await gw.call('sorter', 'Олег, тел. +7 916 123-45-67', SorterOutput, {
      redact: { names: ['Олег'], restore: false },
    })
    expect(r).toMatchObject({ ok: true, output: { reason: 'Это [имя 1], тел. [телефон 1]' } })
  })
})

describe('what pseudonymized says', () => {
  it('NFR-PRIV-2: a call that carries a client but names no one is not marked as pseudonymized', async () => {
    const gw = await gateway({
      FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
        sorter: { verdict: 'fit', reason: 'да', tags: [], confidence: 0.9 },
        probe: { ok: true },
      }),
    })
    const text = 'Меня зовут Ирина, нужен сайт'
    await gw.call('sorter', text, SorterOutput, { redact: { names: [] } })
    await gw.call('sorter', text, SorterOutput, { redact: { names: [null, ' '] } })
    await gw.call('sorter', text, SorterOutput, { redact: { names: ['Ирина'] } })
    await gw.call('probe', 'Проверка связи.', ProbeOutput)
    const rows = await db.execute<{ pseudonymized: boolean }>(
      sql`select pseudonymized from core.model_call order by started_at, id`,
    )
    expect(rows.rows.map((r) => r.pseudonymized)).toEqual([false, false, true, true])
  })
})

describe('Claude limit in the gateway', () => {
  const SORTED = { verdict: 'fit', reason: 'да', tags: [], confidence: 0.9 }
  const BY_ROLE = JSON.stringify({ sorter: SORTED, probe: { ok: true } })

  it('FR-OPS-3: a P2 call that meets the limit waits for its end, then answers', async () => {
    const env = { FAKE_CLAUDE_MODE: 'limit', FAKE_CLAUDE_OUTPUT_BY_ROLE: BY_ROLE }
    const sent: string[] = []
    const gw = await gateway(env, true, { sent, limit: { probeEveryMs: 150 } })
    const pending = gw.call('sorter', 'x', SorterOutput)
    await until(async () => (await calls()).some((c) => roleOf(c) === 'probe'))
    expect(sent).toEqual([LIMIT_TEXTS.started])
    const freed = Date.now()
    env.FAKE_CLAUDE_MODE = 'ok'
    expect(await pending).toMatchObject({ ok: true, output: SORTED })
    expect(sent).toEqual([LIMIT_TEXTS.started, LIMIT_TEXTS.ended])
    const rows = await db.execute<{ ok: boolean; error_class: string | null; started_at: string }>(
      sql`select ok, error_class, started_at from core.model_call where role = 'sorter' order by started_at`,
    )
    expect(rows.rows.map(({ ok, error_class }) => ({ ok, error_class }))).toEqual([
      { ok: false, error_class: 'limit_reached' },
      { ok: true, error_class: null },
    ])
    // The second run is dated when it ran, not when the call began to wait; the wait is journaled.
    expect(new Date(rows.rows[1]?.started_at ?? 0).getTime()).toBeGreaterThanOrEqual(freed)
    const events = await db.execute<{ payload: { waitedMs?: number } }>(
      sql`select payload from core.event where type = 'model.called' and payload->>'role' = 'sorter'`,
    )
    expect(events.rows[0]?.payload.waitedMs).toBeGreaterThan(0)
  })

  it('FR-OPS-3: a slow answer from a run that began before the limit does not end it', async () => {
    const env: Record<string, string> = {
      FAKE_CLAUDE_MODE: 'ok',
      FAKE_CLAUDE_DELAY_MS: '800',
      FAKE_CLAUDE_OUTPUT_BY_ROLE: BY_ROLE,
    }
    const sent: string[] = []
    const gw = await gateway(env, true, { sent, limit: { probeEveryMs: 60_000 } })
    const slow = gw.call('sorter', 'x', SorterOutput)
    await new Promise((r) => setTimeout(r, 200))
    env.FAKE_CLAUDE_MODE = 'limit'
    env.FAKE_CLAUDE_DELAY_MS = '0'
    await gw.call('sorter', 'x', SorterOutput, { limitWaitMs: 0 })
    expect(await slow).toMatchObject({ ok: true })
    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toEqual([LIMIT_TEXTS.started])
    expect(await gw.call('scorer', 'x', ScorerOutput, { limitWaitMs: 0 })).toMatchObject({
      errorClass: 'limit_reached',
    })
    expect((await calls()).map(roleOf)).toEqual(['sorter', 'sorter'])
  })

  it('FR-OPS-3: a limit on one model holds only that model, and its own probe ends it', async () => {
    const env: Record<string, string> = {
      FAKE_CLAUDE_MODE: 'limit_json',
      FAKE_CLAUDE_LIMIT_TEXT: "You've hit your Sonnet limit",
      FAKE_CLAUDE_LIMIT_MODELS: 'sonnet',
      FAKE_CLAUDE_OUTPUT_BY_ROLE: BY_ROLE,
    }
    const sent: string[] = []
    const gw = await gateway(env, true, { sent, limit: { probeEveryMs: 150 } })
    expect(
      await gw.call('scorer', 'x', ScorerOutput, { model: 'sonnet', limitWaitMs: 0 }),
    ).toMatchObject({ errorClass: 'limit_reached' })
    expect(await gw.call('sorter', 'x', SorterOutput)).toMatchObject({ ok: true })
    expect(sent).toEqual([LIMIT_TEXTS.started])
    env.FAKE_CLAUDE_LIMIT_MODELS = 'none'
    await until(() => sent.length === 2)
    expect(sent).toEqual([LIMIT_TEXTS.started, LIMIT_TEXTS.ended])
    const probes = (await calls()).filter((c) => roleOf(c) === 'probe')
    expect(probes.map((c) => c.args[c.args.indexOf('--model') + 1])).toContain('sonnet')
    expect(probes.map((c) => c.args[c.args.indexOf('--model') + 1])).not.toContain('haiku')
  })

  it('FR-OPS-3: a context limit is a CLI failure, not the subscription limit', async () => {
    const gw = await gateway({
      FAKE_CLAUDE_MODE: 'limit',
      FAKE_CLAUDE_LIMIT_TEXT: 'Context limit reached',
    })
    expect(await gw.call('probe', 'x', ProbeOutput)).toMatchObject({
      ok: false,
      errorClass: 'cli_failed',
    })
  })

  it('FR-OPS-3: while the limit holds a P0 call runs at once', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'limit' }, true, {
      limit: { probeEveryMs: 60_000 },
    })
    await gw.call('sorter', 'x', SorterOutput, { limitWaitMs: 0 })
    expect(await gw.call('probe', 'x', ProbeOutput)).toMatchObject({
      ok: false,
      errorClass: 'limit_reached',
    })
    expect((await calls()).map(roleOf)).toEqual(['sorter', 'probe'])
  })

  it('FR-OPS-3: a P1-P3 call gives limit_reached after its longest wait, running the CLI once', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'limit' }, true, {
      limit: { probeEveryMs: 60_000, maxWaitMs: 400 },
    })
    const started = Date.now()
    expect(await gw.call('sorter', 'x', SorterOutput)).toMatchObject({
      ok: false,
      errorClass: 'limit_reached',
    })
    // Node's timers may fire a millisecond early by Date.now() (CI saw 399), so allow a few.
    expect(Date.now() - started).toBeGreaterThanOrEqual(395)
    expect((await calls()).map(roleOf)).toEqual(['sorter'])
    expect(await countRows()).toBe(1)
  })

  it('FR-OPS-3: with no wait allowed a P1-P3 call meets the limit at once without the CLI', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'limit' }, true, {
      limit: { probeEveryMs: 60_000 },
    })
    await gw.call('sorter', 'x', SorterOutput, { limitWaitMs: 0 })
    const started = Date.now()
    expect(await withoutLimitWait(gw).call('scorer', 'x', ScorerOutput)).toMatchObject({
      ok: false,
      errorClass: 'limit_reached',
    })
    expect(Date.now() - started).toBeLessThan(300)
    expect((await calls()).map(roleOf)).toEqual(['sorter'])
  })

  it('FR-OPS-3: a call queued when the limit begins does not spend a run on it', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'limit', FAKE_CLAUDE_DELAY_MS: '300' }, true, {
      concurrency: 1,
      limit: { probeEveryMs: 60_000, maxWaitMs: 600 },
    })
    const first = gw.call('probe', 'x', ProbeOutput)
    await new Promise((r) => setTimeout(r, 100))
    const queued = gw.call('sorter', 'x', SorterOutput)
    await first
    expect(await queued).toMatchObject({ ok: false, errorClass: 'limit_reached' })
    expect((await calls()).map(roleOf)).toEqual(['probe'])
  })

  it('FR-OPS-3: after a restart during the limit Boris gets no second start message, and the end at once', async () => {
    const before: string[] = []
    const first = await gateway({ FAKE_CLAUDE_MODE: 'limit' }, true, {
      sent: before,
      limit: { probeEveryMs: 60_000 },
    })
    await first.call('sorter', 'x', SorterOutput, { limitWaitMs: 0 })
    first.stop()
    expect(before).toEqual([LIMIT_TEXTS.started])

    const after: string[] = []
    const second = await gateway(
      { FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_OUTPUT_BY_ROLE: BY_ROLE },
      true,
      { sent: after, limit: { probeEveryMs: 60_000 } },
    )
    // No call is needed: the new gateway reads the journal and probes at once.
    await until(() => after.length > 0)
    expect(await second.call('sorter', 'x', SorterOutput)).toMatchObject({ ok: true })
    expect(after).toEqual([LIMIT_TEXTS.ended])
    expect((await calls()).map(roleOf)).toEqual(['sorter', 'probe', 'sorter'])
  })

  it('FR-OPS-3: a stand-in row of a wait that ran out is no limit answer: a restart after the limit ended finds none', async () => {
    const now = Date.now()
    const row = (id: string, ago: number, ok: boolean, ms: number) => ({
      id,
      role: 'sorter',
      roleVersion: 1,
      model: 'haiku',
      priority: 'P1',
      startedAt: new Date(now - ago).toISOString(),
      durationMs: ms,
      ok,
      errorClass: ok ? null : 'limit_reached',
      pseudonymized: true,
    })
    await db.insert(modelCall).values([
      row('0192f3c4-5b6a-7c8d-9e0f-aabbccdd0001', 60_000, false, 40),
      // The probe that ended the limit, then a call that gave up waiting (no run: 0 ms) a little later.
      row('0192f3c4-5b6a-7c8d-9e0f-aabbccdd0002', 30_000, true, 40),
      row('0192f3c4-5b6a-7c8d-9e0f-aabbccdd0003', 10_000, false, 0),
    ])
    const sent: string[] = []
    const gw = await gateway(
      { FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_OUTPUT_BY_ROLE: BY_ROLE },
      true,
      { sent, limit: { probeEveryMs: 60_000 } },
    )
    expect(await gw.call('sorter', 'x', SorterOutput)).toMatchObject({ ok: true })
    expect(sent).toEqual([])
  })

  it('FR-OPS-3: after a restart the limit counts its 6 hours from its start, not from the restart', async () => {
    const first = await gateway({ FAKE_CLAUDE_MODE: 'limit' }, true, {
      limit: { probeEveryMs: 60_000 },
    })
    await first.call('sorter', 'x', SorterOutput, { limitWaitMs: 0 })
    first.stop()
    // The limit began 7 hours ago, as the journal has it.
    await db.execute(sql`update core.model_call set started_at = now() - interval '7 hours'`)
    const second = await gateway({ FAKE_CLAUDE_MODE: 'limit' }, true, {
      limit: { probeEveryMs: 60_000 },
    })
    const started = Date.now()
    expect(await second.call('sorter', 'x', SorterOutput)).toMatchObject({
      ok: false,
      errorClass: 'limit_reached',
    })
    expect(Date.now() - started).toBeLessThan(2000)
    // The adopted limit's probe (the third row) is still running: it ends before the next test empties the journal.
    await until(async () => (await countRows()) === 3)
  })

  it('FR-OPS-3: after a restart a call that cannot outwait the known reset time stops waiting at once', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3 * 24 * 3600
    const first = await gateway(
      {
        FAKE_CLAUDE_MODE: 'limit',
        FAKE_CLAUDE_LIMIT_TEXT: `Claude AI usage limit reached|${reset}`,
      },
      true,
      { limit: { probeEveryMs: 60_000 } },
    )
    await first.call('sorter', 'x', SorterOutput, { limitWaitMs: 0 })
    first.stop()
    // The restarted CLI's probe says nothing about the reset: the journal is all the core has.
    const second = await gateway({ FAKE_CLAUDE_MODE: 'limit' }, true, {
      limit: { probeEveryMs: 60_000 },
    })
    const started = Date.now()
    expect(await second.call('sorter', 'x', SorterOutput, { limitWaitMs: 3600_000 })).toMatchObject(
      {
        ok: false,
        errorClass: 'limit_reached',
      },
    )
    expect(Date.now() - started).toBeLessThan(2000)
    // The adopted limit's probe (the third row) is still running: it ends before the next test empties the journal.
    await until(async () => (await countRows()) === 3)
  })
})
