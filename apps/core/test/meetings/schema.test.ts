import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newEventId } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deal, lead, meeting, meetingTurn, v1Bid } from '../../src/db/schema'
import { createDeal } from '../../src/domain/deal'
import { dbErrorMessage, openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const correlationId = newEventId()

async function seedLead(id = '95147898') {
  await db.insert(lead).values({
    id,
    accountId: 'hance-marketing',
    title: 'Сайт',
    category: 'Маркетинг',
    city: 'Краснодар',
    text: 'Нужен сайт',
    clientName: 'Анна',
    bidPriceRub: 150,
    seenAt: new Date().toISOString(),
    correlationId,
  })
}

async function v1Deal(orderId = '90000001') {
  const id = newEventId()
  await db.insert(deal).values({
    id,
    leadId: null,
    orderId,
    origin: 'v1',
    accountId: 'hance-marketing',
    stage: 'talking',
  })
  return id
}

function meetingRow(dealId: string, state: string) {
  return {
    id: newEventId(),
    dealId,
    accountId: 'hance-marketing',
    kind: 'boris',
    state,
    startsAt: '2026-10-30T12:00:00.000Z',
    durationMin: 30,
    createdBy: 'boris',
  }
}

describe('meeting tables', () => {
  it('FR-MEET-4: a deal without a lead can hold an outcome and an amount', async () => {
    const id = await v1Deal()
    await db
      .update(deal)
      .set({ outcome: 'won', amountRub: 120000, outcomeAt: new Date().toISOString() })
      .where(eq(deal.id, id))
    const [row] = await db.select().from(deal).where(eq(deal.id, id))
    expect(row).toMatchObject({ leadId: null, orderId: '90000001', outcome: 'won', amountRub: 120000 })
  })

  it('FR-MEET-2: a deal has at most one active meeting', async () => {
    const id = await v1Deal()
    await db.insert(meeting).values(meetingRow(id, 'booked'))
    expect(await dbErrorMessage(db.insert(meeting).values(meetingRow(id, 'offered')))).toMatch(
      /meeting_one_active/,
    )
    await db.insert(meeting).values(meetingRow(id, 'done'))
    const rows = await db.select().from(meeting).where(eq(meeting.dealId, id))
    expect(rows).toHaveLength(2)
  })

  it('FR-MEET-4: one deal per order of an account', async () => {
    await v1Deal('90000002')
    expect(await dbErrorMessage(v1Deal('90000002'))).toMatch(/deal_account_order/)
  })

  it('FR-MEET-4: old deals get their order number from the lead', async () => {
    await seedLead()
    // A deal as written before M6: no order number.
    await db.insert(deal).values({
      id: newEventId(),
      leadId: '95147898',
      accountId: 'hance-marketing',
      stage: 'bid_sent',
    })
    const dir = join(__dirname, '../../drizzle')
    const file = readdirSync(dir).find((f) => f.endsWith('_meetings.sql'))
    expect(file).toBeDefined()
    const backfill = readFileSync(join(dir, file as string), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .find((s) => /^update "core"\."deal"/i.test(s))
    expect(backfill).toBeDefined()
    await db.execute(sql.raw(backfill as string))
    const [row] = await db.select().from(deal).where(eq(deal.leadId, '95147898'))
    expect(row?.orderId).toBe('95147898')
  })

  it('FR-MEET-4: a deal made by a bid has its order number', async () => {
    await seedLead()
    const id = await createDeal(db, { leadId: '95147898', accountId: 'hance-marketing', correlationId })
    const [row] = await db.select().from(deal).where(eq(deal.id, id))
    expect(row).toMatchObject({ leadId: '95147898', orderId: '95147898', origin: 'sara' })
  })

  it('FR-MEET-2: a round decision and an old Sara bid are stored once', async () => {
    await db.insert(meetingTurn).values({ roundKey: 'conv-turn:a:1|1', result: { handled: false } })
    expect(
      await dbErrorMessage(
        db.insert(meetingTurn).values({ roundKey: 'conv-turn:a:1|1', result: { handled: false } }),
      ),
    ).toMatch(/duplicate key/)
    const v = { orderId: '90000003', accountId: 'hance-marketing', seenAt: new Date().toISOString(), feeRub: 120 }
    await db.insert(v1Bid).values(v)
    expect(await dbErrorMessage(db.insert(v1Bid).values(v))).toMatch(/duplicate key/)
  })
})
