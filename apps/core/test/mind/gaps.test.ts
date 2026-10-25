import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, mindGap } from '../../src/db/schema'
import { recordGap, topGap } from '../../src/mind/gaps'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

describe('knowledge gaps', () => {
  it('FR-MIND-4: the most frequent gap of the week is chosen', async () => {
    await recordGap(db, { turnId: 't-1', text: 'Есть ли кейсы клиник?', topic: 'cases' })
    await recordGap(db, { turnId: 't-2', text: '  есть ли  кейсы клиник ', topic: 'cases' })
    await recordGap(db, { turnId: 't-3', text: 'Сколько стоит лендинг', topic: 'price' })
    for (const turnId of ['t-4', 't-5', 't-6']) {
      await recordGap(db, { turnId, text: 'Работаете ли по договору', topic: 'contract' })
    }
    await db
      .update(mindGap)
      .set({ createdAt: daysAgo(10) })
      .where(eq(mindGap.topic, 'contract'))

    expect(await topGap(db, 7)).toEqual({ text: 'есть ли  кейсы клиник', count: 2 })
    expect(await topGap(db, 14)).toEqual({ text: 'Работаете ли по договору', count: 3 })
  })

  it('FR-MIND-4: a gap already asked about is not chosen again', async () => {
    await recordGap(db, { turnId: 't-1', text: 'Есть ли кейсы клиник?', topic: 'cases' })
    await recordGap(db, { turnId: 't-2', text: 'Есть ли кейсы клиник', topic: 'cases' })
    await recordGap(db, { turnId: 't-3', text: 'Сколько стоит лендинг', topic: 'price' })
    await db
      .update(mindGap)
      .set({ questionId: '0190c2f4-0000-7000-8000-000000000001' })
      .where(eq(mindGap.topic, 'cases'))
    expect(await topGap(db, 7)).toEqual({ text: 'Сколько стоит лендинг', count: 1 })
  })

  it('FR-MIND-4: a gap is kept with its turn, the journal has only its topic', async () => {
    expect(await topGap(db, 7)).toBeNull()
    await recordGap(db, { turnId: 't-1', text: 'Сколько стоит лендинг для Анны', topic: 'price' })
    await recordGap(db, { turnId: 't-2', text: '   ', topic: 'other' })
    const rows = await db.select().from(mindGap)
    expect(rows).toEqual([
      expect.objectContaining({
        turnId: 't-1',
        text: 'Сколько стоит лендинг для Анны',
        topic: 'price',
      }),
    ])
    expect(await countEvents(db, 'mind.gap_recorded')).toBe(1)
    const [e] = await db.select().from(event).where(eq(event.type, 'mind.gap_recorded'))
    expect(e?.payload).toEqual({ topic: 'price' })
    expect(e?.entityId).toBe('t-1')
  })
})
