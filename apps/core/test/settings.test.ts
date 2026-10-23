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
