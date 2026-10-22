import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { deal, lead } from '../src/db/schema'
import { createDeal, TransitionError, transition } from '../src/domain/deal'
import * as journal from '../src/journal/journal'
import { openTestDb, resetDb } from './helpers/db'
import { countEvents } from './helpers/events'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
  vi.restoreAllMocks()
})

const correlationId = newEventId()

async function seedLead() {
  await db.insert(lead).values({
    id: '1',
    accountId: 'hance-marketing',
    title: 'Сайт',
    category: 'Маркетинг',
    city: 'Краснодар',
    text: 'Нужен сайт',
    clientName: 'Анна',
    bidPriceRub: 210,
    seenAt: new Date().toISOString(),
    correlationId,
  })
  return createDeal(db, { leadId: '1', accountId: 'hance-marketing', correlationId })
}

async function stageOf(id: string) {
  const [row] = await db.select({ stage: deal.stage }).from(deal).where(eq(deal.id, id))
  return row?.stage
}

describe('deal state machine', () => {
  it('NFR-REL-3: a new deal starts at bid_sent with one event', async () => {
    const id = await seedLead()
    expect(await stageOf(id)).toBe('bid_sent')
    expect(await countEvents(db, 'deal.stage_changed')).toBe(1)
  })

  it('NFR-REL-3: allowed transition changes the stage and writes an event', async () => {
    const id = await seedLead()
    await transition(db, { dealId: id, to: 'talking', actor: 'sara', reason: null, correlationId })
    expect(await stageOf(id)).toBe('talking')
    expect(await countEvents(db, 'deal.stage_changed')).toBe(2)
  })

  it('NFR-REL-3: forbidden transition writes nothing', async () => {
    const id = await seedLead()
    await expect(
      transition(db, { dealId: id, to: 'won', actor: 'sara', reason: null, correlationId }),
    ).rejects.toBeInstanceOf(TransitionError)
    expect(await stageOf(id)).toBe('bid_sent')
    expect(await countEvents(db, 'deal.stage_changed')).toBe(1)
  })

  it('NFR-REL-3: stage and event are written in one transaction', async () => {
    const id = await seedLead()
    vi.spyOn(journal, 'appendEvent').mockRejectedValueOnce(new Error('journal down'))
    await expect(
      transition(db, { dealId: id, to: 'talking', actor: 'sara', reason: null, correlationId }),
    ).rejects.toThrow('journal down')
    expect(await stageOf(id)).toBe('bid_sent')
  })
})
