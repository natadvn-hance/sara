import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { meeting } from '../src/db/schema'
import { slotsText, type WorkHours, workHoursSlots, workHoursSource } from '../src/leads/callSlots'
import { firstName } from '../src/leads/clientName'
import { greetingFor } from '../src/text/clientText'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

/** A moment by its Moscow wall clock (UTC+3). 2.11.2026 is a Monday. */
const msk = (iso: string) => new Date(`${iso}+03:00`)
const NOW = msk('2026-11-02T11:00')
const WORK: WorkHours = {
  hours: { from: 11, to: 20 },
  days: [1, 2, 3, 4, 5],
  slotMin: 30,
  minAheadMin: 120,
  preferred: ['16:00', '17:30'],
  night: { from: 23, to: 8 },
}
const iso = (xs: Date[]) => xs.map((t) => t.toISOString())

describe('the call times go round the clients (Boris, 01.11.2026: «предлагай разные слоты всем»)', () => {
  it('FR-LEAD-6: two clients in a row are offered different times, today and tomorrow', async () => {
    const source = workHoursSource(db)
    const first = await source.slots(NOW, { leadId: '95000001' })
    const second = await source.slots(NOW, { leadId: '95000002' })
    expect(slotsText(first, NOW)).toBe('сегодня в 16:00 или 17:30, или лучше завтра')
    expect(second.length).toBeGreaterThan(0)
    expect(second.some((t) => iso(first).includes(t.toISOString()))).toBe(false)
    // Boris’s times are taken: the next client gets the nearest free starts, still two hours ahead.
    expect(second[0]?.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 120 * 60_000)
    const third = await source.slots(NOW, { leadId: '95000003' })
    expect(third.some((t) => [...iso(first), ...iso(second)].includes(t.toISOString()))).toBe(false)
  })

  it('FR-LEAD-6: the same client asking again gets his own times back', async () => {
    const source = workHoursSource(db)
    const first = await source.slots(NOW, { leadId: '95000001' })
    await source.slots(NOW, { leadId: '95000002' })
    expect(iso(await source.slots(NOW, { leadId: '95000001' }))).toEqual(iso(first))
  })

  it('FR-LEAD-6: times offered long ago, 48 hours, are free again', async () => {
    const source = workHoursSource(db)
    const first = await source.slots(NOW, { leadId: '95000001' })
    const later = msk('2026-11-04T11:30')
    const again = await source.slots(later, { leadId: '95000002' })
    expect(slotsText(again, later)).toBe('сегодня в 16:00 или 17:30, или лучше завтра')
    expect(iso(first)).not.toEqual(iso(again))
  })

  it('FR-LEAD-6: a meeting already set takes its time', async () => {
    await db.insert(meeting).values({
      id: crypto.randomUUID(),
      title: 'Созвон',
      startsAt: msk('2026-11-02T16:00').toISOString(),
    })
    const got = await workHoursSource(db).slots(NOW, { leadId: '95000001' })
    expect(iso(got)).not.toContain(msk('2026-11-02T16:00').toISOString())
    expect(iso(got)).toContain(msk('2026-11-02T17:30').toISOString())
  })

  it('FR-LEAD-6: a test order takes no time of a real client, and a real one is offered what it would be alone', async () => {
    const source = workHoursSource(db)
    const alone = iso(workHoursSlots(NOW, WORK))
    const test = await source.slots(NOW, { leadId: '99123456789' })
    expect(iso(test)).toEqual(alone)
    // The test order recorded nothing: the next real client is offered what he would be alone.
    const real = await source.slots(NOW, { leadId: '95000001' })
    expect(iso(real)).toEqual(alone)
  })

  it('FR-LEAD-6: with no one taken the times are the same as before (the pure rule)', () => {
    const w = WORK
    expect(slotsText(workHoursSlots(NOW, w), NOW)).toBe(
      'сегодня в 16:00 или 17:30, или лучше завтра',
    )
    // Taken today: the day’s free starts, and the next working day’s.
    const busy = [
      msk('2026-11-02T16:00'),
      msk('2026-11-02T17:30'),
      msk('2026-11-03T16:00'),
      msk('2026-11-03T17:30'),
    ]
    const free = workHoursSlots(NOW, w, busy)
    expect(free.some((t) => busy.some((b) => b.getTime() === t.getTime()))).toBe(false)
    expect(free.length).toBe(4)
  })
})

describe('the name a client is greeted by (Boris, 01.11.2026)', () => {
  it('FR-LEAD-6: a name in Latin letters is a Russian name, formal', () => {
    expect(firstName('alexander')).toBe('Александр')
    expect(firstName('Dmitriy Ivanov')).toBe('Дмитрий')
    expect(firstName('Таня')).toBe('Татьяна')
    expect(firstName('Татьяна Иванова')).toBe('Татьяна')
    expect(firstName('Анна(Юля)')).toBe('Анна')
  })

  it('FR-LEAD-6: a profession, a company, a nick or a stand-in is no name', () => {
    for (const bad of [
      'Психотерапевт',
      'ООО Ромашка',
      'ИП Иванов',
      'Клиент 3',
      'user_8841',
      'beauty_studio',
      '',
      'Саша',
    ])
      expect(firstName(bad)).toBeNull()
  })

  it('FR-LEAD-6: the greeting is always there, with the formal name or without one', () => {
    const noon = new Date('2026-11-02T10:00:00Z')
    expect(greetingFor(noon, 'alexander')).toBe('Александр, добрый день!')
    expect(greetingFor(noon, 'Психотерапевт')).toBe('Добрый день!')
    expect(greetingFor(noon, 'ООО Ромашка')).toBe('Добрый день!')
    expect(greetingFor(noon, 'Татьяна')).toBe('Татьяна, добрый день!')
  })
})
