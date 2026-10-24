import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProfiOrder, type ScorerOutput } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { RULES_V1 } from '../src/direction/v1'
import { createGateway } from '../src/gateway/gateway'
import { decide, scoreOrder, scorerInput } from '../src/leads/scorer'
import { createSecretStore } from '../src/secrets/store'
import { openTestDb, resetDb } from './helpers/db'

const ROOT = resolve(import.meta.dirname, '../../..')
const { db, close } = openTestDb()
afterAll(close)
let dir: string
let log: string
beforeEach(async () => {
  await resetDb(db)
  dir = await mkdtemp(join(tmpdir(), 'scorer-'))
  log = join(dir, 'calls.log')
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
})

/** A Scorer answer whose five axes all score `v`, so the weighted score is `v`. */
export function scorerAnswer(v: number, over: Partial<ScorerOutput> = {}): ScorerOutput {
  return {
    stop_factor: null,
    red_flags: [],
    axes: RULES_V1.axes.map((a) => ({ id: a.id, score: v, why: 'так' })),
    reason: 'Зрелый бизнес, понятная задача',
    confidence: 0.9,
    ...over,
  }
}

const order = async () =>
  ProfiOrder.parse(
    JSON.parse(await readFile(join(ROOT, 'tests/fixtures/orders/90000001.json'), 'utf8')),
  )

async function gateway(byRole: Record<string, unknown>) {
  const secrets = createSecretStore(join(dir, 'data'))
  await secrets.set('claude_oauth_token', 'tok')
  return createGateway({
    db,
    secrets,
    claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
    rolesDir: join(dir, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: { FAKE_CLAUDE_ARGS_LOG: log, FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify(byRole) },
  })
}
const calls = async (): Promise<{ args: string[]; stdin: string }[]> =>
  (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
const modelOf = (args: string[]) => args[args.indexOf('--model') + 1]

describe('scorer', () => {
  it("FR-LEAD-3: the Scorer never sees the client's name", async () => {
    const text = scorerInput({ ...(await order()), client_name: 'Андрей' }, RULES_V1)
    expect(text).not.toContain('Андрей')
    expect(text).toContain((await order()).text)
    expect(text).toContain('Порог: 56')
  })

  it('FR-LEAD-3: a stop factor drops the order whatever the score', () => {
    expect(decide(RULES_V1, scorerAnswer(90, { stop_factor: 'direct' }))).toEqual({
      score: 90,
      decision: 'drop',
    })
  })

  it('FR-LEAD-3: below the threshold is dropped, at the threshold is shown', () => {
    expect(decide(RULES_V1, scorerAnswer(55)).decision).toBe('drop')
    expect(decide(RULES_V1, scorerAnswer(56)).decision).toBe('show')
  })

  it('FR-LEAD-3: a borderline haiku score is redone on sonnet and sonnet decides', async () => {
    const gw = await gateway({
      'scorer@haiku': scorerAnswer(60),
      'scorer@sonnet': scorerAnswer(40, { reason: 'Разовая задача' }),
    })
    const r = await scoreOrder(gw, await order(), RULES_V1)
    expect(r).toMatchObject({
      score: 40,
      decision: 'drop',
      model: 'sonnet',
      reason: 'Разовая задача',
    })
    expect((await calls()).map((c) => modelOf(c.args))).toEqual(['haiku', 'sonnet'])
  })

  it('FR-LEAD-3: an unsure haiku score is redone on sonnet', async () => {
    const gw = await gateway({
      'scorer@haiku': scorerAnswer(85, { confidence: 0.5 }),
      'scorer@sonnet': scorerAnswer(80),
    })
    expect((await scoreOrder(gw, await order(), RULES_V1))?.model).toBe('sonnet')
  })

  it('FR-LEAD-3: a clear haiku score is not redone', async () => {
    const gw = await gateway({ scorer: scorerAnswer(85) })
    expect(await scoreOrder(gw, await order(), RULES_V1)).toMatchObject({
      score: 85,
      decision: 'show',
      model: 'haiku',
    })
    expect(await calls()).toHaveLength(1)
  })

  it('FR-LEAD-3: without escalation a borderline score stays on haiku', async () => {
    const gw = await gateway({ scorer: scorerAnswer(60) })
    expect((await scoreOrder(gw, await order(), RULES_V1, { escalate: false }))?.model).toBe(
      'haiku',
    )
    expect(await calls()).toHaveLength(1)
  })

  it('FR-LEAD-3: an unknown stop factor id or missing axis counts as a failed score', async () => {
    const bad = await gateway({ scorer: scorerAnswer(85, { stop_factor: 'nonsense' }) })
    expect(await scoreOrder(bad, await order(), RULES_V1)).toBeNull()
    const short = await gateway({ scorer: { ...scorerAnswer(85), axes: [] } })
    expect(await scoreOrder(short, await order(), RULES_V1)).toBeNull()
  })
})
