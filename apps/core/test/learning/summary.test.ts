import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { task } from '../../src/db/schema'
import { seedDirection } from '../../src/direction/store'
import { dailySummary } from '../../src/learning/summary'
import type { Notifier } from '../../src/notify/notifier'
import { openTestDb, resetDb } from '../helpers/db'
import { droppedLead } from '../helpers/learning'

const { db, close } = openTestDb()
afterAll(close)
type Sent = { text: string; rows: { text: string; callbackData: string }[][] }
let sent: Sent[] = []
const notifier: Notifier = {
  sendLeadCard: async () => ({ messageId: 1 }),
  sendText: async (text) => {
    sent.push({ text, rows: [] })
    return { messageId: 2 }
  },
  sendButtons: async (text, rows) => {
    sent.push({ text, rows })
    return { messageId: 3 }
  },
}
beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  sent = []
})
// 25.10.2026: 19:30 and 18:59 in Moscow (UTC+3); orders seen that morning.
const AT_1930 = new Date('2026-10-25T16:30:00Z')
const AT_1859 = new Date('2026-10-25T15:59:00Z')
const MORNING = '2026-10-25T07:00:00Z'

describe('daily summary', () => {
  it("FR-LEAD-7: at 19:00 Moscow time the day's dropped orders come as one summary with up to 3 borderline ones", async () => {
    for (const [id, score] of [
      ['930001', 55],
      ['930002', 50],
      ['930003', 47],
      ['930004', 44],
      ['930005', 20],
    ] as const)
      await droppedLead(db, id, score, { seenAt: MORNING })
    await droppedLead(db, '930006', 54, { seenAt: MORNING, stopFactor: 'direct' })
    // Yesterday's dropped order is not today's.
    await droppedLead(db, '930007', 55, { seenAt: '2026-10-24T07:00:00Z' })
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text.split('\n')).toEqual([
      'Сегодня отсеяла 6. На грани:',
      '1. Заказ 930001, балл 55: причина 930001',
      '2. Заказ 930002, балл 50: причина 930002',
      '3. Заказ 930003, балл 47: причина 930003',
    ])
    expect(sent[0]?.rows.map((r) => r.map((b) => b.text))).toEqual([
      ['Взял бы №1'],
      ['Взял бы №2'],
      ['Взял бы №3'],
    ])
    expect(sent[0]?.rows[0]?.[0]?.callbackData).toMatch(/^t:.+:want$/)
    const reviews = await db.select().from(task).where(eq(task.kind, 'lead_review'))
    expect(reviews.map((t) => t.entityId).sort()).toEqual(['930001', '930002', '930003'])
  })

  it('FR-LEAD-7: before 19:00 there is no summary; a second tick the same day sends nothing', async () => {
    await droppedLead(db, '930011', 50, { seenAt: MORNING })
    expect(await dailySummary({ db, notifier }, AT_1859)).toBe('not_yet')
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    expect(await dailySummary({ db, notifier }, new Date(AT_1930.getTime() + 60_000))).toBe(
      'already',
    )
    expect(sent).toHaveLength(1)
  })

  it('NFR-REL-3: two cores ticking at once send one summary', async () => {
    await droppedLead(db, '930021', 50, { seenAt: MORNING })
    const r = await Promise.all([
      dailySummary({ db, notifier }, AT_1930),
      dailySummary({ db, notifier }, AT_1930),
    ])
    expect(r.sort()).toEqual(['already', 'sent'])
    expect(sent).toHaveLength(1)
  })

  it('FR-LEAD-7: without borderline orders the summary is one line', async () => {
    await droppedLead(db, '930031', 20, { seenAt: MORNING })
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    expect(sent).toEqual([{ text: 'Сегодня отсеяла 1, пограничных не было', rows: [] }])
  })

  it('FR-LEAD-7: a day without dropped orders sends nothing', async () => {
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('none')
    expect(sent).toHaveLength(0)
  })

  it('FR-LEAD-7: a summary that could not be sent is tried again on the next tick', async () => {
    await droppedLead(db, '930041', 50, { seenAt: MORNING })
    const failing: Notifier = {
      ...notifier,
      sendButtons: async () => {
        throw new Error('telegram down')
      },
    }
    await expect(dailySummary({ db, notifier: failing }, AT_1930)).rejects.toThrow()
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
  })

  it('FR-LEAD-7: the summary covers 19:00 yesterday to 19:00 today, so evening orders are not lost', async () => {
    // 20:00 Moscow on the 24th: after yesterday's summary, so it belongs to today's.
    await droppedLead(db, '930051', 52, { seenAt: '2026-10-24T17:00:00Z' })
    // 19:10 Moscow today: after today's summary time, it waits for tomorrow's.
    await droppedLead(db, '930052', 53, { seenAt: '2026-10-25T16:10:00Z' })
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    expect(sent[0]?.text.split('\n')).toEqual([
      'Сегодня отсеяла 1. На грани:',
      '1. Заказ 930051, балл 52: причина 930051',
    ])
    sent = []
    expect(await dailySummary({ db, notifier }, new Date('2026-10-26T16:30:00Z'))).toBe('sent')
    expect(sent[0]?.text).toContain('Заказ 930052')
  })
})
