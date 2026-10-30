import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { event, modelCall } from '../../src/db/schema'
import { createGateway } from '../../src/gateway/gateway'
import { createRedactor } from '../../src/gateway/redact'
import { createSecretStore } from '../../src/secrets/store'
import { ROOT } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'

const FAKE = join(ROOT, 'tests/fakes/fake-claude.mjs')
const { db, close } = openTestDb()
afterAll(close)

let dir: string
let log: string
let mcp: { configPath: string; server: string; tools: string[] }
const stops: (() => void)[] = []
beforeEach(async () => {
  await resetDb(db)
  dir = await mkdtemp(join(tmpdir(), 'converse-'))
  log = join(dir, 'calls.log')
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
  mcp = { configPath: join(dir, 'mcp.json'), server: 'sara', tools: ['leads'] }
  await writeFile(
    mcp.configPath,
    JSON.stringify({ mcpServers: { sara: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }),
  )
})
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

async function gateway(env: Record<string, string>) {
  const secrets = createSecretStore(join(dir, 'data'))
  await secrets.set('claude_oauth_token', 'tok')
  const gw = createGateway({
    db,
    secrets,
    claudeBin: FAKE,
    rolesDir: join(dir, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: () => ({ FAKE_CLAUDE_ARGS_LOG: log, ...env }),
  })
  stops.push(gw.stop)
  return gw
}

const runs = async () =>
  (await readFile(log, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args?: string[]; stdin?: string })
    .filter((c) => c.args)

const answer = (text: string) => JSON.stringify({ secretary: { calls: [], answer: text } })

describe('a conversation turn through the gateway', () => {
  it('FR-NOTIF-4: the turn runs Opus at medium effort, hides the client in the input, brings him back in the answer and is journaled', async () => {
    const gw = await gateway({
      FAKE_CLAUDE_OUTPUT_BY_ROLE: answer('Да, [имя 1] ждёт ответа: [телефон 1]'),
    })
    const redactor = createRedactor(['Ирина'])
    const r = await gw.converse('secretary', 'Что ответила Ирина? Её номер +7 916 123-45-67', {
      redactor,
      mcp,
      maxBudgetUsd: 3,
    })
    expect(r).toMatchObject({ ok: true, text: 'Да, Ирина ждёт ответа: +7 916 123-45-67' })
    const [run] = await runs()
    expect(run?.stdin).toBe('Что ответила [имя 1]? Её номер [телефон 1]')
    const after = (flag: string) => run?.args?.[run.args.indexOf(flag) + 1]
    expect(after('--model')).toBe('opus')
    expect(after('--effort')).toBe('medium')
    expect(after('--mcp-config')).toBe(mcp.configPath)
    const [row] = await db.select().from(modelCall)
    expect(row).toMatchObject({ role: 'secretary', model: 'opus', ok: true, pseudonymized: true })
    const [called] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, 'model.called'), eq(event.entityId, row?.id ?? '')))
    expect(called?.payload).toMatchObject({ role: 'secretary', costUsd: 0.01, turns: 1 })
  })

  it('FR-OPS-3: in a limit the turn says when it ends, and the next one does not run at all', async () => {
    const gw = await gateway({
      FAKE_CLAUDE_MODE: 'limit_json',
      FAKE_CLAUDE_LIMIT_TEXT: "You've hit your weekly limit · resets 2am (Europe/Moscow)",
    })
    const first = await gw.converse('secretary', 'что в очереди', {
      redactor: createRedactor(),
      mcp,
    })
    expect(first).toMatchObject({ ok: false, errorClass: 'limit_reached' })
    const reset = first.ok ? null : first.resetAt
    expect(reset).toBeInstanceOf(Date)
    const second = await gw.converse('secretary', 'ну?', { redactor: createRedactor(), mcp })
    expect(second).toMatchObject({ ok: false, errorClass: 'limit_reached', resetAt: reset })
    expect(await runs()).toHaveLength(1)
  })

  it('FR-NOTIF-4: a run the CLI ended with an error (the budget, say) is a failure, not an answer', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'exit1' })
    const r = await gw.converse('secretary', 'привет', { redactor: createRedactor(), mcp })
    expect(r).toMatchObject({ ok: false, errorClass: 'cli_failed' })
  })
})
