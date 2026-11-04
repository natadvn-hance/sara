import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, lead, leadScore, task } from '../../src/db/schema'
import { activeRules, insertVersion, seedDirection } from '../../src/direction/store'
import { dailySummary } from '../../src/learning/summary'
import type { Notifier } from '../../src/notify/notifier'
import { openTestDb, resetDb } from '../helpers/db'
import { droppedLead, heldLead } from '../helpers/learning'

const { db, close } = openTestDb()
afterAll(close)
type Sent = { text: string; rows: { text: string; callbackData: string }[][] }
let sent: Sent[] = []
const notifier: Notifier = {
  sendLeadCard: async () => ({ messageId: 1 }),
  closeLeadCard: async () => {},
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

/** The numbered orders of a report: «Заказ 930001 55», in their order. */
const orders = (text = '') =>
  [
    ...text.matchAll(/^\d+\. <a [^>]*>([^<]+)<\/a>, (?:балл )?([^\n]*?)(?: при пороге \d+)?$/gm),
  ].map((m) => `${m[1]} ${m[2]}`)
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
    expect(sent[0]?.text).toContain('Балл или стоп-фактор: 6')
    expect(orders(sent[0]?.text)).toEqual(['Заказ 930001 55', 'Заказ 930002 50', 'Заказ 930003 47'])
    expect(sent[0]?.rows.map((r) => r.map((b) => b.text))).toEqual([
      ['Взял бы №1'],
      ['Взял бы №2'],
      ['Взял бы №3'],
    ])
    expect(sent[0]?.rows[0]?.[0]?.callbackData).toMatch(/^t:.+:want$/)
    const reviews = await db.select().from(task).where(eq(task.kind, 'lead_review'))
    expect(reviews.map((t) => t.entityId).sort()).toEqual(['930001', '930002', '930003'])
  })

  it('FR-LEAD-7: the band «на грани» is under the threshold of each kind: marketing 40, sites 55', async () => {
    const rules = await activeRules(db, 'hance-marketing')
    await db.transaction((tx) =>
      insertVersion(tx, {
        accountId: 'hance-marketing',
        rules: {
          ...rules.rules,
          threshold: 50,
          kind_thresholds: { marketing: 40, sites: 55, other: 50 },
        },
        createdBy: 'boris',
        reason: 'тест',
      }),
    )
    // The scores were given under v1 (56): the band reads the version they were scored under, so score them under v2.
    await droppedLead(db, '930021', 35, { seenAt: MORNING, category: 'Маркетолог' })
    await droppedLead(db, '930022', 45, { seenAt: MORNING, category: 'Создание сайтов' })
    await droppedLead(db, '930023', 44, { seenAt: MORNING, category: 'Авитолог' })
    await db.update(leadScore).set({ version: 2 })
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    // 35 is five under marketing's 40, 45 is ten under the sites' 55, 44 is six under the rest's 50: all «на грани».
    expect(orders(sent[0]?.text)).toEqual(['Заказ 930022 45', 'Заказ 930023 44', 'Заказ 930021 35'])
  })

  it('FR-LEAD-7: a score above its kind’s threshold is not «на грани», ten under it still is', async () => {
    const rules = await activeRules(db, 'hance-marketing')
    await db.transaction((tx) =>
      insertVersion(tx, {
        accountId: 'hance-marketing',
        rules: {
          ...rules.rules,
          threshold: 50,
          kind_thresholds: { marketing: 40, sites: 55, other: 50 },
        },
        createdBy: 'boris',
        reason: 'тест',
      }),
    )
    await droppedLead(db, '930031', 30, { seenAt: MORNING, category: 'Маркетолог' })
    await droppedLead(db, '930032', 45, { seenAt: MORNING, category: 'Маркетолог' })
    await db.update(leadScore).set({ version: 2 })
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    // 45 is above marketing's 40 (it would have shown), 30 is ten under: on the edge of the band.
    expect(orders(sent[0]?.text)).toEqual(['Заказ 930031 30'])
    expect(sent[0]?.text).not.toContain('930032')
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
    expect(sent[0]?.rows).toEqual([])
    expect(sent[0]?.text).toContain('Балл или стоп-фактор: 1')
    expect(sent[0]?.text).not.toContain('Почти прошли')
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
    expect(orders(sent[0]?.text)).toEqual(['Заказ 930051 52'])
    sent = []
    expect(await dailySummary({ db, notifier }, new Date('2026-10-26T16:30:00Z'))).toBe('sent')
    expect(sent[0]?.text).toContain('Заказ 930052')
  })

  it('FR-NOTIF-3: orders held over the card cap come under «Ещё показала бы» with a button each', async () => {
    await heldLead(db, '940001', { seenAt: MORNING, score: 70, bidPriceRub: 300 })
    await heldLead(db, '940002', { seenAt: MORNING, score: 80 })
    await heldLead(db, '940003', { seenAt: MORNING, score: 70, bidPriceRub: 150 })
    await heldLead(db, '940004', { seenAt: MORNING, score: null })
    // Held a day and a half ago and never shown: too old to offer now.
    await heldLead(db, '940005', { seenAt: '2026-10-24T07:00:00Z', score: 90 })
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('Ещё показала бы')
    expect(orders(sent[0]?.text)).toEqual([
      'Заказ 940002 80',
      'Заказ 940003 70',
      'Заказ 940001 70',
      'Заказ 940004 без оценки',
    ])
    expect(sent[0]?.rows.map((r) => r.map((b) => b.text))).toEqual([
      ['Показать №1'],
      ['Показать №2'],
      ['Показать №3'],
      ['Показать №4'],
    ])
    expect(sent[0]?.rows[0]?.[0]?.callbackData).toMatch(/^t:.+:open$/)
    const held = await db.select().from(task).where(eq(task.kind, 'lead_held'))
    expect(held.map((t) => t.entityId).sort()).toEqual(['940001', '940002', '940003', '940004'])
    // The one too old to offer leaves the held orders for good, and the journal says why.
    const [old] = await db.select().from(lead).where(eq(lead.id, '940005'))
    expect(old?.status).toBe('stale')
    const stale = await db.select().from(event).where(eq(event.type, 'lead.stale'))
    expect(stale.map((e) => e.entityId)).toEqual(['940005'])
  })

  it('FR-NOTIF-3: an order held after the summary window closed but before the summary ran still comes', async () => {
    // 19:02 Moscow time, the window of the 19:30 summary ends at 19:00.
    await heldLead(db, '940041', { seenAt: '2026-10-25T16:02:00Z', score: 70 })
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    expect(sent[0]?.text).toContain('Заказ 940041')
  })

  it('FR-NOTIF-3: an order held at 19:05 yesterday is still in the next summary, 24 hours and a tick later', async () => {
    await heldLead(db, '940042', { seenAt: '2026-10-24T16:05:00Z', score: 70 })
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    expect(sent[0]?.text).toContain('Заказ 940042')
    expect((await db.select().from(lead).where(eq(lead.id, '940042')))[0]?.status).toBe('held')
  })

  it('FR-NOTIF-3: an order already offered in a summary is neither listed again nor aged out by the next ones', async () => {
    // 19:20 Moscow time: 24 hours 10 minutes old at the next summary, so only the offer keeps it out of the list.
    await heldLead(db, '940043', { seenAt: '2026-10-25T16:20:00Z', score: 70 })
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    sent = []
    await droppedLead(db, '930091', 55, { seenAt: '2026-10-26T07:00:00Z' })
    expect(await dailySummary({ db, notifier }, new Date('2026-10-26T16:30:00Z'))).toBe('sent')
    expect(sent[0]?.text).not.toContain('Заказ 940043')
    expect(await db.select().from(task).where(eq(task.kind, 'lead_held'))).toHaveLength(1)
    // Two days on it is far over a day old, but its button is still waiting: the order stays held.
    await droppedLead(db, '930092', 55, { seenAt: '2026-10-27T07:00:00Z' })
    expect(await dailySummary({ db, notifier }, new Date('2026-10-27T16:30:00Z'))).toBe('sent')
    expect((await db.select().from(lead).where(eq(lead.id, '940043')))[0]?.status).toBe('held')
    expect(await db.select().from(event).where(eq(event.type, 'lead.stale'))).toHaveLength(0)
  })

  it('FR-NOTIF-3: borderline and held orders share one message and one numbering', async () => {
    await droppedLead(db, '930061', 55, { seenAt: MORNING })
    await heldLead(db, '940011', { seenAt: MORNING, score: 70 })
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    expect(orders(sent[0]?.text)).toEqual(['Заказ 930061 55', 'Заказ 940011 70'])
    expect(sent[0]?.rows.map((r) => r.map((b) => b.text))).toEqual([
      ['Взял бы №1'],
      ['Показать №2'],
    ])
  })

  it('FR-NOTIF-3: past 10 held orders the rest are counted, not listed', async () => {
    await droppedLead(db, '930071', 20, { seenAt: MORNING })
    for (let i = 10; i < 22; i++) await heldLead(db, `9400${i}`, { seenAt: MORNING, score: 60 + i })
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
    const lines = sent[0]?.text.split('\n') ?? []
    expect(orders(sent[0]?.text)[0]).toBe('Заказ 940021 81')
    expect(lines.at(-1)).toBe('И ещё 2 заявки')
    expect(sent[0]?.rows).toHaveLength(10)
  })

  it('FR-NOTIF-3: a summary that could not be sent leaves no held tasks behind', async () => {
    await heldLead(db, '940031', { seenAt: MORNING, score: 70 })
    const failing: Notifier = {
      ...notifier,
      sendButtons: async () => {
        throw new Error('telegram down')
      },
    }
    await expect(dailySummary({ db, notifier: failing }, AT_1930)).rejects.toThrow()
    expect(await db.select().from(task)).toHaveLength(0)
    expect(await dailySummary({ db, notifier }, AT_1930)).toBe('sent')
  })
})
