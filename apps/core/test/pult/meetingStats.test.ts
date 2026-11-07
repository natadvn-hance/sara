import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureConversation } from '../../src/conversation/store'
import { lead, meeting } from '../../src/db/schema'
import { meetingStats } from '../../src/pult/meetingStats'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
const NOW = new Date('2026-11-10T09:00:00.000Z')

beforeEach(async () => {
  await resetDb(db)
  await db.insert(lead).values({
    id: '95680762',
    accountId: 'acc',
    title: 'T',
    category: 'C',
    city: 'Москва',
    text: 't',
    clientName: 'Анна',
    bidPriceRub: 290,
    seenAt: NOW.toISOString(),
    correlationId: newEventId(),
    status: 'bid_sent',
  })
})

describe('meeting stats by month', () => {
  it('FR-CONV-13: counts booked, held, missed and without a word; maybe, cancelled and duplicates stay out', async () => {
    const conv = await ensureConversation(db, {
      accountId: 'acc',
      chatId: '95680762',
      orderId: '95680762',
    })
    const row = (startsAt: string, status: string, outcome: string | null) =>
      db.insert(meeting).values({
        id: newEventId(),
        conversationId: conv.id,
        title: 'Созвон',
        startsAt,
        status,
        outcome,
        source: 'chat',
      })
    await row('2026-11-02T10:00:00.000Z', 'booked', 'held')
    await row('2026-11-03T10:00:00.000Z', 'booked', 'missed')
    await row('2026-11-04T10:00:00.000Z', 'booked', null) // passed, no word
    await row('2026-11-20T10:00:00.000Z', 'booked', null) // ahead
    await row('2026-11-05T10:00:00.000Z', 'maybe', null)
    await row('2026-11-06T10:00:00.000Z', 'duplicate', null)
    await row('2026-11-07T10:00:00.000Z', 'cancelled', null)
    await row('2026-10-31T21:30:00.000Z', 'booked', 'held') // 00:30 of 1 November in Moscow
    const rows = await meetingStats(db, 2026, NOW)
    const nov = rows.find((r) => r.month === 'Ноябрь')
    expect(nov).toEqual({ month: 'Ноябрь', booked: 5, held: 2, missed: 1, noWord: 1 })
    expect(rows.at(-1)).toMatchObject({ month: 'ИТОГО', booked: 5, held: 2, missed: 1, noWord: 1 })
  })
})
