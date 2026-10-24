import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { leadLabel } from '../../src/db/schema'
import { seedDirection } from '../../src/direction/store'
import { recordLabel, sweepIgnored } from '../../src/learning/labels'
import { openTestDb, resetDb } from '../helpers/db'
import { leadWithScore } from '../helpers/learning'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
})

const labelOf = async (id: string) =>
  await db.select().from(leadLabel).where(eq(leadLabel.leadId, id))

describe('labels', () => {
  it('FR-LEAD-7: «Откликнуться» is a yes, «Пропустить» is a no, each once', async () => {
    await leadWithScore(db, '900001', 70)
    expect(await recordLabel(db, { leadId: '900001', label: 'yes', source: 'card' })).toEqual({
      created: true,
      surprise: false,
    })
    expect((await recordLabel(db, { leadId: '900001', label: 'no', source: 'card' })).created).toBe(
      false,
    )
    const rows = await labelOf('900001')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ label: 'yes', source: 'card', score: 70, scoreVersion: 1 })
  })

  it('FR-LEAD-7: skipping a card of 71 under threshold 56 is a surprise, of 70 is not', async () => {
    await leadWithScore(db, '900002', 71)
    await leadWithScore(db, '900003', 70)
    expect(
      (await recordLabel(db, { leadId: '900002', label: 'no', source: 'card' })).surprise,
    ).toBe(true)
    expect(
      (await recordLabel(db, { leadId: '900003', label: 'no', source: 'card' })).surprise,
    ).toBe(false)
    expect((await labelOf('900002'))[0]?.surprise).toBe(true)
  })

  it('FR-LEAD-7: «Взял бы» on a dropped order is always a surprise', async () => {
    await leadWithScore(db, '900004', 50)
    expect(
      (await recordLabel(db, { leadId: '900004', label: 'yes', source: 'summary' })).surprise,
    ).toBe(true)
  })

  it('FR-LEAD-7: a card untouched for 24 hours is a weak no without a question', async () => {
    await leadWithScore(db, '900005', 70, 25)
    await leadWithScore(db, '900006', 70, 23)
    expect(await sweepIgnored(db, new Date())).toBe(1)
    expect((await labelOf('900005'))[0]).toMatchObject({
      label: 'weak_no',
      source: 'ignored',
      surprise: false,
    })
    expect(await labelOf('900006')).toHaveLength(0)
    expect(await sweepIgnored(db, new Date())).toBe(0)
  })
})
