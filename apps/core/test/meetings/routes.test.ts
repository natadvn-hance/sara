import { DEFAULT_AVAILABILITY } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { event, settingHistory } from '../../src/db/schema'
import { getSetting } from '../../src/settings/store'
import { buildTestApp, type TestApp } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

let t: TestApp
beforeEach(async () => {
  await resetDb(db)
  t = await buildTestApp(db)
  await t.app.inject({
    method: 'POST',
    url: '/api/setup/password',
    payload: { password: 'длинныйпароль1' },
  })
})
afterEach(() => t.close())

const URL = '/api/meetings/availability'
const put = (payload: unknown, cookie = true) =>
  t.app.inject({
    method: 'PUT',
    url: URL,
    payload: payload as object,
    headers: cookie ? { cookie: t.cookie() } : {},
  })

describe('free time API', () => {
  it('FR-MEET-1: the free time and the next free times are shown', async () => {
    const res = await t.app.inject({ method: 'GET', url: URL, headers: { cookie: t.cookie() } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.availability).toEqual(DEFAULT_AVAILABILITY)
    expect(body.preview).toHaveLength(3)
    expect(body.preview[0]).toMatchObject({
      startsAt: expect.any(String),
      label: expect.any(String),
    })
  })

  it('FR-MEET-1: saving free time keeps the history and journals the change', async () => {
    const friday = {
      ...DEFAULT_AVAILABILITY,
      week: { ...DEFAULT_AVAILABILITY.week, fri: [{ from: '10:00', to: '13:00' }] },
    }
    const res = await put(friday)
    expect(res.statusCode).toBe(200)
    expect(res.json().availability.week.fri).toEqual([{ from: '10:00', to: '13:00' }])
    expect(await getSetting(db, 'meet.availability')).toEqual(friday)
    const history = await db
      .select()
      .from(settingHistory)
      .where(eq(settingHistory.key, 'meet.availability'))
    expect(history).toHaveLength(1)
    expect(history[0]?.changedBy).toBe('boris')
    const events = await db.select().from(event).where(eq(event.type, 'setting.changed'))
    expect(events.some((e) => e.entityId === 'meet.availability')).toBe(true)
  })

  it('FR-MEET-1: overlapping windows are a 400 with a plain reason', async () => {
    const bad = {
      ...DEFAULT_AVAILABILITY,
      week: {
        ...DEFAULT_AVAILABILITY.week,
        mon: [
          { from: '10:00', to: '13:00' },
          { from: '12:00', to: '14:00' },
        ],
      },
    }
    const res = await put(bad)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Проверь окна: начало раньше конца, окна дня не пересекаются.')
    expect(await getSetting(db, 'meet.availability')).toEqual(DEFAULT_AVAILABILITY)
  })

  it('FR-MEET-1: without a session it is 401', async () => {
    expect((await t.app.inject({ method: 'GET', url: URL })).statusCode).toBe(401)
    expect((await put(DEFAULT_AVAILABILITY, false)).statusCode).toBe(401)
  })
})
