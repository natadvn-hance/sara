import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { outboxNode } from '../src/db/schema'
import { createEyes, type Eyes } from '../src/eyes/eyes'
import type { OrderSignal } from '../src/eyes/parsers'
import { standInParsers } from '../src/eyes/parsers'
import { openNodeTestDb, resetNodeDb } from './helpers/db'

// FR-LEAD-5: an order the last pass over the board saw and this one does not is gone from the feed (Boris,
// 30.10.2026): the core reads its page at once, so a closed order's card closes before Boris presses on it.
const { db, close } = openNodeTestDb()
afterAll(close)

let eyes: Eyes
beforeEach(async () => {
  await resetNodeDb(db)
  eyes = createEyes({ accountId: 'hance-marketing', db, parsers: standInParsers })
})

const order = (id: string): OrderSignal => ({
  t: 'order',
  order: {
    order_id: id,
    title: 'Сайт',
    category: 'Сайты',
    city: 'Краснодар',
    text: 'Нужен сайт',
    client_name: 'Ирина',
    budget_text: null,
    bid_price_rub: 0,
    seen_at: new Date().toISOString(),
  },
  published_at: null,
})

/** One pass over the board: its pages as the site answered them, the last one saying whether more follow. */
async function pass(pages: string[][], o: { end?: boolean; at?: number } = {}) {
  eyes.boardPassStart()
  for (const [i, ids] of pages.entries()) {
    const more = i < pages.length - 1 || o.end !== true
    await eyes.onParsed(
      { recognized: true, what: 'feed', signals: ids.map(order), more },
      'response',
    )
  }
  await eyes.boardPassEnd(o.at)
}

const gone = async () =>
  (await db.select().from(outboxNode))
    .map((r) => r.payload as { type: string; entity: { id: string }; payload: { page: number } })
    .filter((e) => e.type === 'profi.order_gone')
    .map((e) => ({ id: e.entity.id, page: e.payload.page }))

describe('an order gone from the feed (FR-LEAD-5)', () => {
  it('FR-LEAD-5: an order of the last pass missing from this one, on a page both loaded, is told gone once', async () => {
    await pass([['1', '2'], ['3', '4'], ['5']])
    await pass([['1'], ['3', '4'], ['5', '6']])
    expect(await gone()).toEqual([{ id: '2', page: 0 }])
    // Still missing a minute later: not told again within the hour.
    await pass([['1'], ['3', '4'], ['5', '6']])
    expect(await gone()).toHaveLength(1)
  })

  it('FR-LEAD-5: an order on the last page loaded may only have moved down a page: not gone', async () => {
    await pass([
      ['1', '2'],
      ['3', '4'],
    ])
    await pass([['1', '2'], ['3']])
    expect(await gone()).toEqual([])
  })

  it('FR-LEAD-5: a pass that loaded fewer pages tells nothing of the pages it did not load', async () => {
    await pass([['1'], ['2'], ['3'], ['4']])
    await pass([['1'], ['2']])
    expect(await gone()).toEqual([])
  })

  it('FR-LEAD-5: a board read to its end covers its last page too', async () => {
    await pass(
      [
        ['1', '2'],
        ['3', '4'],
      ],
      { end: true },
    )
    await pass([['1', '2'], ['3']], { end: true })
    expect(await gone()).toEqual([{ id: '4', page: 1 }])
  })

  it('FR-LEAD-5: a pass without any board answer (the feed did not open) neither tells nor forgets', async () => {
    await pass([['1', '2'], ['3']])
    await pass([])
    await pass([['1'], ['3']])
    expect(await gone()).toEqual([{ id: '2', page: 0 }])
  })

  it('FR-LEAD-5: an order that keeps leaving and coming back is told again after an hour', async () => {
    const t0 = Date.now()
    await pass([['1', '2'], ['3']], { at: t0 })
    await pass([['1'], ['3']], { at: t0 })
    await pass([['1', '2'], ['3']], { at: t0 + 30 * 60_000 })
    await pass([['1'], ['3']], { at: t0 + 30 * 60_000 })
    expect(await gone()).toHaveLength(1)
    await pass([['1', '2'], ['3']], { at: t0 + 61 * 60_000 })
    await pass([['1'], ['3']], { at: t0 + 61 * 60_000 })
    expect(await gone()).toHaveLength(2)
  })

  it('FR-LEAD-5: board answers outside a pass (the way back to the feed) are not a pass', async () => {
    await pass([['1', '2'], ['3']])
    await eyes.onParsed(
      { recognized: true, what: 'feed', signals: [order('9')], more: true },
      'response',
    )
    await pass([['1', '2'], ['3']])
    expect(await gone()).toEqual([])
  })
})
