import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getSetting, setSetting } from '../src/settings/store'
import { openTestDb, resetDb } from './helpers/db'
import { countEvents } from './helpers/events'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

describe('settings', () => {
  it('C7: default is returned when unset and a wrong value is rejected', async () => {
    expect(await getSetting(db, 'outbound.bids')).toBe(false)
    await expect(setSetting(db, 'reminder.decision_after_min', -1, 'boris')).rejects.toThrow()
  })

  it("C7: money and card limits default to old Sara's values", async () => {
    expect(await getSetting(db, 'money.daily_bids')).toBe(10)
    expect(await getSetting(db, 'money.daily_budget_rub')).toBeNull()
    expect(await getSetting(db, 'money.max_fee_rub')).toBeNull()
    expect(await getSetting(db, 'cards.max_per_day')).toBe(10)
    expect(await getSetting(db, 'cards.quiet_hours')).toEqual({ from: 23, to: 9 })
    await expect(setSetting(db, 'money.daily_bids', 0, 'boris')).rejects.toThrow()
    await expect(
      setSetting(db, 'cards.quiet_hours', { from: 24, to: 9 }, 'boris'),
    ).rejects.toThrow()
    await setSetting(db, 'money.max_fee_rub', 300, 'boris')
    expect(await getSetting(db, 'money.max_fee_rub')).toBe(300)
    // Back to «no ceiling».
    await setSetting(db, 'money.max_fee_rub', null, 'boris')
    expect(await getSetting(db, 'money.max_fee_rub')).toBeNull()
  })

  it('C7: setting change is stored with history and an event', async () => {
    await setSetting(db, 'outbound.bids', true, 'boris')
    expect(await getSetting(db, 'outbound.bids')).toBe(true)
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from core.setting_history`,
    )
    expect(rows.rows[0]?.n).toBe(1)
    expect(await countEvents(db, 'setting.changed')).toBe(1)
  })
})
