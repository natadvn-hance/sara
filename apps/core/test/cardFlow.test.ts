import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { task } from '../src/db/schema'
import { cardsToday, isQuietHour, isStale } from '../src/leads/cardFlow'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const NOW = new Date('2026-10-25T12:00:00Z')
/** A moment at hh:mm Moscow time (UTC+3) on 25.10.2026. */
const msk = (hhmm: string) => new Date(`2026-10-25T${hhmm}:00+03:00`)

describe('card flow', () => {
  it('FR-LEAD-10: an order published over 24 hours ago is stale', () => {
    expect(isStale('2026-10-24T11:59:00Z', NOW)).toBe(true)
    expect(isStale('2026-10-24T12:01:00Z', NOW)).toBe(false)
  })

  it('FR-LEAD-10: an order without a publication time is never stale', () => {
    expect(isStale(null, NOW)).toBe(false)
    expect(isStale(undefined, NOW)).toBe(false)
  })

  it('FR-NOTIF-2: quiet hours from 23 to 9 wrap past midnight, by Moscow time', () => {
    const q = { from: 23, to: 9 }
    expect(isQuietHour(msk('22:59'), q)).toBe(false)
    expect(isQuietHour(msk('23:00'), q)).toBe(true)
    expect(isQuietHour(msk('03:00'), q)).toBe(true)
    expect(isQuietHour(msk('08:59'), q)).toBe(true)
    expect(isQuietHour(msk('09:00'), q)).toBe(false)
  })

  it('FR-NOTIF-2: quiet hours within a day, all day, or none', () => {
    expect(isQuietHour(msk('13:30'), { from: 13, to: 15 })).toBe(true)
    expect(isQuietHour(msk('15:00'), { from: 13, to: 15 })).toBe(false)
    expect(isQuietHour(msk('12:59'), { from: 13, to: 15 })).toBe(false)
    expect(isQuietHour(msk('12:00'), { from: 5, to: 5 })).toBe(true)
    expect(isQuietHour(msk('03:00'), null)).toBe(false)
  })

  it("FR-NOTIF-3: cardsToday counts the Moscow day's decision cards", async () => {
    const add = (createdAt: string, kind = 'lead_decision', messageId: number | null = 1) =>
      db.insert(task).values({
        id: newEventId(),
        kind,
        entityKind: 'lead',
        entityId: newEventId(),
        createdAt,
        telegramMessageId: messageId,
      })
    await add('2026-10-25T08:00:00Z')
    // 25.10 at 00:30 Moscow time.
    await add('2026-10-24T21:30:00Z')
    // 24.10 at 23:30 Moscow time: yesterday.
    await add('2026-10-24T20:30:00Z')
    // A card the bot could not send yet still counts: the reminder brings it later.
    await add('2026-10-25T09:00:00Z', 'lead_decision', null)
    // Not a lead card.
    await add('2026-10-25T09:00:00Z', 'lead_review')
    expect(await cardsToday(db, NOW)).toBe(3)
  })
})
