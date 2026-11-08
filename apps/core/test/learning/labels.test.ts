import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, leadLabel } from '../../src/db/schema'
import { seedDirection } from '../../src/direction/store'
import { reasonOnCard, recordLabel, setReason, sweepIgnored } from '../../src/learning/labels'
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
  it('FR-LEAD-7: «Откликнуться» is a yes, «Закрыть заявку» is a no, each once', async () => {
    await leadWithScore(db, '900001', 70)
    expect(await recordLabel(db, { leadId: '900001', label: 'yes', source: 'card' })).toMatchObject(
      {
        created: true,
        surprise: false,
      },
    )
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

  it('FR-LEAD-7: a close from the card keeps what the rules need to guess why: score, flags, category, fee; no client words', async () => {
    await leadWithScore(db, '900010', 71)
    await recordLabel(db, { leadId: '900010', label: 'no', source: 'card' })
    const [e] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, 'lead.labeled'), eq(event.entityId, '900010')))
    expect(e?.payload).toMatchObject({
      label: 'no',
      surprise: true,
      features: {
        category: 'Реклама на ТВ',
        city: 'Москва',
        fee_rub: 148,
        score: 71,
        score_version: 1,
        score_decision: 'show',
        red_flags: [],
        score_reason: 'так',
        has_draft: false,
      },
    })
    const text = JSON.stringify(e?.payload)
    expect(text).not.toContain('Андрей')
    expect(text).not.toContain('федеральные каналы')
    // A label from the summary or the ignore sweep carries none.
    await leadWithScore(db, '900011', 50)
    await recordLabel(db, { leadId: '900011', label: 'yes', source: 'summary' })
    const [s] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, 'lead.labeled'), eq(event.entityId, '900011')))
    expect(s?.payload).not.toHaveProperty('features')
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

  it('07.11: a close keeps the reason Sara guesses from the card; the journal has its code, not the order', async () => {
    await leadWithScore(db, '900020', 71)
    expect(await recordLabel(db, { leadId: '900020', label: 'no', source: 'card' })).toMatchObject({
      created: true,
      reason: { code: 'profile', detail: 'Реклама на ТВ' },
      by: 'guess',
    })
    expect((await labelOf('900020'))[0]).toMatchObject({
      reasonCode: 'profile',
      reasonDetail: 'Реклама на ТВ',
      reasonBy: 'guess',
      guessCode: 'profile',
    })
    const [e] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, 'lead.labeled'), eq(event.entityId, '900020')))
    expect(e?.payload).toMatchObject({ reason_code: 'profile', reason_by: 'guess' })
    expect(JSON.stringify(e?.payload)).not.toContain('федеральные каналы')
  })

  it("07.11: Boris's own words with a close (the pult) are his reason, not a guess; a yes has none", async () => {
    await leadWithScore(db, '900021', 71)
    await recordLabel(db, { leadId: '900021', label: 'no', source: 'pult', reason: 'копейки' })
    expect((await labelOf('900021'))[0]).toMatchObject({
      reason: 'копейки',
      reasonCode: 'budget',
      reasonBy: 'boris',
      guessCode: null,
    })
    await leadWithScore(db, '900022', 71)
    await recordLabel(db, { leadId: '900022', label: 'yes', source: 'card' })
    expect((await labelOf('900022'))[0]).toMatchObject({ reasonCode: null, reasonBy: null })
    expect(await reasonOnCard(db, '900022')).toBeNull()
  })

  it('07.11: a card nobody pressed gets the guess too', async () => {
    await leadWithScore(db, '900023', 70, 25)
    await sweepIgnored(db, new Date())
    expect((await labelOf('900023'))[0]).toMatchObject({
      label: 'weak_no',
      reasonCode: 'profile',
      reasonBy: 'guess',
    })
  })

  it('07.11: one press makes the reason his; the first guess stays beside it and the press is journaled', async () => {
    await leadWithScore(db, '900024', 71)
    await recordLabel(db, { leadId: '900024', label: 'no', source: 'card' })
    expect(await reasonOnCard(db, '900024')).toEqual({
      reason: { code: 'profile', detail: 'Реклама на ТВ' },
      by: 'guess',
      buttons: ['site', 'budget', 'client', 'other'],
    })
    expect(await setReason(db, '900024', 'budget', new Date())).toEqual({
      code: 'budget',
      detail: null,
    })
    expect((await labelOf('900024'))[0]).toMatchObject({
      reasonCode: 'budget',
      reasonBy: 'boris',
      guessCode: 'profile',
    })
    expect(await reasonOnCard(db, '900024')).toEqual({
      reason: { code: 'budget', detail: null },
      by: 'boris',
      buttons: [],
    })
    const [e] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, 'lead.reason_set'), eq(event.entityId, '900024')))
    expect(e?.payload).toEqual({ code: 'budget', detail: null, was: 'profile', guess: 'profile' })
    // Nothing to explain on a yes or on a lead without a label.
    await leadWithScore(db, '900025', 71)
    await recordLabel(db, { leadId: '900025', label: 'yes', source: 'card' })
    expect(await setReason(db, '900025', 'budget', new Date())).toBeNull()
    expect(await setReason(db, '900026', 'budget', new Date())).toBeNull()
  })
})
