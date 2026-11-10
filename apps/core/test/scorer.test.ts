import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProfiOrder } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { RULES_V1 } from '../src/direction/v1'
import { createGateway } from '../src/gateway/gateway'
import { decide, scoreOrder, scorerInput } from '../src/leads/scorer'
import { createSecretStore } from '../src/secrets/store'
import { openTestDb, resetDb } from './helpers/db'
import { scorerAnswer } from './helpers/scorer'

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
  it('NFR-PRIV-2: a name inside the order text never reaches the Scorer', async () => {
    const gw = await gateway({ scorer: scorerAnswer(85) })
    const o = { ...(await order()), text: 'Меня зовут Ирина, нужен сайт', client_name: 'Ирина' }
    await scoreOrder(gw, o, RULES_V1)
    const [c] = await calls()
    expect(c?.stdin).not.toContain('Ирина')
    expect(c?.stdin).toContain('Меня зовут [имя 1], нужен сайт')
  })

  it("FR-LEAD-3: the Scorer never sees the client's name", async () => {
    const text = scorerInput({ ...(await order()), client_name: 'Андрей' }, RULES_V1)
    expect(text).not.toContain('Андрей')
    expect(text).toContain((await order()).text)
    expect(text).toContain('Порог: 56')
  })

  it("FR-MIND-3: the Scorer sees Boris's decisions on similar orders after the order, their clients' names hidden", async () => {
    const gw = await gateway({ scorer: scorerAnswer(85) })
    const precedents = [
      {
        leadId: '1',
        title: 'Ведение Instagram для кофейни Тимура',
        category: 'SMM',
        clientName: 'Тимур',
        label: 'no' as const,
        reason: { code: 'profile' as const, detail: 'SMM ведение' },
        chosen: false,
      },
      {
        leadId: '2',
        title: 'Стратегия продвижения клиники',
        category: 'Маркетинг',
        clientName: 'Вера',
        label: 'yes' as const,
        reason: null,
        chosen: false,
      },
      {
        leadId: '3',
        title: 'Ведение ВК',
        category: 'SMM',
        clientName: 'Олег',
        label: 'no' as const,
        reason: { code: 'budget' as const, detail: null },
        chosen: true,
      },
    ]
    await scoreOrder(gw, await order(), RULES_V1, { escalate: false, precedents })
    const [c] = await calls()
    expect(c?.stdin).toContain(
      [
        'Решения Бориса по похожим заказам (его прошлые нажатия, самые похожие первыми): откликнулся на 1 из 3; похожих меньше 10, доля ещё ничего не говорит.',
        '- «Ведение Instagram для кофейни [имя 1]» (SMM): закрыл, похоже: не наш профиль: SMM ведение',
        '- «Стратегия продвижения клиники» (Маркетинг): откликнулся',
        '- «Ведение ВК» (SMM): закрыл, причина: маленький бюджет',
      ].join('\n'),
    )
    expect(c?.stdin).not.toContain('Тимур')
    // Without precedents the input is as it always was.
    expect(scorerInput(await order(), RULES_V1)).not.toContain('Решения Бориса')
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

  it('FR-LEAD-3: each kind of order has its own threshold: 52 shows marketing at 40 and drops a site at 55', () => {
    const rules = {
      ...RULES_V1,
      threshold: 50,
      kind_thresholds: { marketing: 40, sites: 55, other: 50 },
    }
    expect(decide(rules, scorerAnswer(52), 'Маркетолог').decision).toBe('show')
    expect(decide(rules, scorerAnswer(52), 'Создание сайтов').decision).toBe('drop')
    expect(decide(rules, scorerAnswer(52), 'Авитолог').decision).toBe('show')
    expect(decide(rules, scorerAnswer(49), 'Авитолог').decision).toBe('drop')
    // Without kinds in the rules the plain threshold is everyone's, as before.
    expect(decide(RULES_V1, scorerAnswer(55), 'Маркетолог').decision).toBe('drop')
  })

  it('FR-LEAD-3: the Scorer sees the threshold of the order’s own kind', async () => {
    const rules = {
      ...RULES_V1,
      threshold: 50,
      kind_thresholds: { marketing: 40, sites: 55, other: 50 },
    }
    const o = { ...(await order()), category: 'Создание сайтов' }
    expect(scorerInput(o, rules)).toContain('Порог: 55')
    expect(scorerInput({ ...o, category: 'Маркетолог' }, rules)).toContain('Порог: 40')
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
