import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lead } from '../../src/db/schema'
import { contradictions } from '../../src/direction/contradictions'
import { DEFAULT_REPLY_FORMAT } from '../../src/direction/profile'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'
import { leadWithScore } from '../helpers/learning'
import { CASE } from '../helpers/onboarding'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
beforeEach(() => resetDb(db))

const profile = (over: object = {}) => ({
  speed: 'normal' as const,
  reply_format: { ...DEFAULT_REPLY_FORMAT, max_cases: 0 },
  cases: [],
  ...over,
})
const ids = async (p = profile()) => (await contradictions({ db }, ACC, p)).map((c) => c.id)

describe('speed and money contradictions', { timeout: 30000 }, () => {
  it('FR-ACC-3: nothing is said when nothing contradicts', async () => {
    expect(await ids()).toEqual([])
  })

  it('FR-ACC-3: a day budget below the ceiling of one bid is named', async () => {
    await setSetting(db, 'money.daily_budget_rub', 100, 'boris')
    await setSetting(db, 'money.max_fee_rub', 300, 'boris')
    const [c] = await contradictions({ db }, ACC, profile())
    expect(c).toMatchObject({ id: 'budget_below_ceiling' })
    expect(c?.text).toContain('100')
    expect(c?.text).toContain('300')
    expect(c?.fix).toBeNull()
  })

  it('FR-ACC-3: a ceiling below the usual price of a bid is named with that price', async () => {
    for (const [i, fee] of [150, 140, 160].entries()) {
      await leadWithScore(db, `973${i}`, 70)
      await db
        .update(lead)
        .set({ bidPriceRub: fee })
        .where(eq(lead.id, `973${i}`))
    }
    await setSetting(db, 'money.max_fee_rub', 100, 'boris')
    const [c] = await contradictions({ db }, ACC, profile())
    expect(c).toMatchObject({ id: 'ceiling_below_fee' })
    expect(c?.text).toContain('150')
  })

  it('FR-ACC-3: fast mode with bids switched off is named and can be fixed in the profile', async () => {
    const [c] = await contradictions({ db }, ACC, profile({ speed: 'fast' }))
    expect(c).toMatchObject({ id: 'fast_without_bids', fix: { patch: { speed: 'normal' } } })
    await setSetting(db, 'outbound.bids', true, 'boris')
    expect(await ids(profile({ speed: 'fast' }))).toEqual([])
  })

  it('FR-ACC-3: more bids a day than cards a day is named', async () => {
    await setSetting(db, 'money.daily_bids', 20, 'boris')
    await setSetting(db, 'cards.max_per_day', 10, 'boris')
    expect(await ids()).toEqual(['bids_over_cards'])
  })

  it('FR-ACC-3: cases allowed in a bid but none in the library is named and can be fixed', async () => {
    const p = profile({ reply_format: { ...DEFAULT_REPLY_FORMAT, max_cases: 2 } })
    const [c] = await contradictions({ db }, ACC, p)
    expect(c).toMatchObject({ id: 'cases_empty' })
    expect(c?.fix?.patch).toMatchObject({ reply_format: { max_cases: 0 } })
    expect(
      await ids(
        profile({ reply_format: { ...DEFAULT_REPLY_FORMAT, max_cases: 2 }, cases: [CASE] }),
      ),
    ).toEqual([])
  })
})
