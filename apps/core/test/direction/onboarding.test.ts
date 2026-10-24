import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { proposeStep } from '../../src/direction/onboarding'
import { RULES_V1 } from '../../src/direction/v1'
import { openTestDb, resetDb } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'
import { ABOUT, IDEAL, STOPS } from '../helpers/onboarding'

const { db, close } = openTestDb()
afterAll(close)
// The gateway remembers a Claude limit from core.model_call, so every case starts from an empty database.
beforeEach(() => resetDb(db))

const BAD_WEIGHTS = { ...IDEAL, axes: IDEAL.axes.map((a) => ({ ...a, weight: 30 })) }
const NOTHING = { say: 'слова', confirmed: {}, current: null }

describe('onboarding steps', { timeout: 30000 }, () => {
  it('FR-ACC-3: step 1 returns the understanding and the structured about', async () => {
    const { gateway, calls } = await fakeGateway(db, { 'onboarding-about': ABOUT })
    const r = await proposeStep({ gateway }, 1, {
      say: 'Мы делаем маркетинг для малого бизнеса, стратегии, сайты и воронки',
      confirmed: {},
      current: null,
    })
    expect(r).toEqual({
      ok: true,
      understood: ABOUT.understood,
      data: {
        about: ABOUT.about,
        services: ABOUT.services,
        clients: ABOUT.clients,
        budgets: ABOUT.budgets,
      },
    })
    const [call] = await calls()
    expect(call?.role).toBe('onboarding-about')
    expect(call?.stdin).toContain('Мы делаем маркетинг для малого бизнеса')
  })

  it('FR-ACC-3: step 2 gives stop factors and red flags apart', async () => {
    const { gateway } = await fakeGateway(db, { 'onboarding-stops': STOPS })
    const r = await proposeStep({ gateway }, 2, NOTHING)
    expect(r).toMatchObject({
      ok: true,
      data: { stop_factors: [{ id: 'direct' }], red_flags: [{ id: 'cheap' }] },
    })
  })

  it('FR-ACC-3: step 3 axes that do not add up to 100 are asked once more with the error', async () => {
    const { gateway, calls } = await fakeGateway(db, {
      'onboarding-ideal': { $sequence: [BAD_WEIGHTS, IDEAL] },
    })
    const r = await proposeStep({ gateway }, 3, NOTHING)
    expect(r).toMatchObject({ ok: true, data: { threshold: 55 } })
    const all = await calls()
    expect(all).toHaveLength(2)
    expect(all[0]?.stdin).not.toContain('не подошёл')
    expect(all[1]?.stdin).toContain('Прошлый ответ не подошёл')
    expect(all[1]?.stdin).toContain('100')
  })

  it('FR-ACC-3: a second invalid answer is a miss, not a crash', async () => {
    const { gateway, calls } = await fakeGateway(db, { 'onboarding-ideal': BAD_WEIGHTS })
    expect(await proposeStep({ gateway }, 3, NOTHING)).toEqual({ ok: false, reason: 'invalid' })
    expect(await calls()).toHaveLength(2)
  })

  it('FR-ACC-3: stop factors with the same id are asked once more', async () => {
    const twice = { ...STOPS, stop_factors: [STOPS.stop_factors[0], STOPS.stop_factors[0]] }
    const { gateway, calls } = await fakeGateway(db, {
      'onboarding-stops': { $sequence: [twice, STOPS] },
    })
    expect(await proposeStep({ gateway }, 2, NOTHING)).toMatchObject({ ok: true })
    expect(await calls()).toHaveLength(2)
  })

  it('FR-ACC-3: an answer off the schema is asked once more, then a miss', async () => {
    const { gateway, calls } = await fakeGateway(db, { 'onboarding-about': { oops: 1 } })
    expect(await proposeStep({ gateway }, 1, NOTHING)).toEqual({ ok: false, reason: 'invalid' })
    expect(await calls()).toHaveLength(2)
  })

  it('FR-ACC-3: a model failure is a miss', async () => {
    const { gateway } = await fakeGateway(
      db,
      { 'onboarding-about': ABOUT },
      { FAKE_CLAUDE_MODE: 'exit1' },
    )
    expect(await proposeStep({ gateway }, 1, NOTHING)).toEqual({ ok: false, reason: 'no_answer' })
  })

  it('FR-ACC-3: the Claude limit is told apart from a failure and never waits', async () => {
    const { gateway } = await fakeGateway(
      db,
      { 'onboarding-about': ABOUT },
      { FAKE_CLAUDE_MODE: 'limit' },
    )
    expect(await proposeStep({ gateway }, 1, NOTHING)).toEqual({ ok: false, reason: 'limit' })
  })

  it("FR-ACC-3: Boris's correction and the previous attempt go into the next call", async () => {
    const { gateway, calls } = await fakeGateway(db, { 'onboarding-about': ABOUT })
    await proposeStep({ gateway }, 1, {
      say: 'маркетинг для малого бизнеса',
      fix: 'Не малого, а среднего',
      previous: { understood: 'Вы работаете с малым бизнесом.' },
      confirmed: {},
      current: null,
    })
    const [call] = await calls()
    expect(call?.stdin).toContain('Вы работаете с малым бизнесом.')
    expect(call?.stdin).toContain('Не малого, а среднего')
  })

  it('FR-ACC-3: in edit mode the call carries the current section and what was confirmed before', async () => {
    const { gateway, calls } = await fakeGateway(db, { 'onboarding-ideal': IDEAL })
    await proposeStep({ gateway }, 3, {
      say: 'лучшие заказы про системность',
      confirmed: { about: 'Подтверждённое описание', stopFactorIds: ['direct'] },
      current: RULES_V1,
    })
    const [call] = await calls()
    expect(call?.stdin).toContain('Качество клиента')
    expect(call?.stdin).toContain('Подтверждённое описание')
    expect(call?.stdin).toContain('direct')
  })
})
