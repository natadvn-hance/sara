import { type EventType, newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { speedReport } from '../src/analytics/speed'
import { appendEvent } from '../src/journal/journal'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const T0 = Date.parse('2026-10-25T09:00:00Z')

/** One order's journal: each event `sec` seconds after T0. */
async function journal(
  events: { type: EventType; sec: number; payload?: Record<string, unknown> }[],
): Promise<void> {
  const correlation = newEventId()
  for (const e of events) {
    await appendEvent(db, {
      type: e.type,
      v: 1,
      entity: { kind: 'lead', id: correlation },
      account_id: 'hance-marketing',
      actor: 'sara',
      occurred_at: new Date(T0 + e.sec * 1000).toISOString(),
      causation_id: null,
      correlation_id: correlation,
      reason: null,
      payload: e.payload ?? {},
    })
  }
}

describe('speed report', () => {
  it('FR-ANL-3: yes to bid runs from the last press to bid.sent', async () => {
    // Pressed while paused (given back), pressed again 10 minutes later, sent 20 seconds after that.
    await journal([
      { type: 'lead.found', sec: 0 },
      { type: 'task.created', sec: 30 },
      { type: 'task.resolved', sec: 60, payload: { action: 'bid' } },
      { type: 'bid.failed', sec: 61, payload: { reason: 'paused' } },
      { type: 'task.resolved', sec: 660, payload: { action: 'bid' } },
      { type: 'bid.sent', sec: 680 },
    ])
    const r = await speedReport(db)
    expect(r.yesToBid.count).toBe(1)
    expect(r.yesToBid.p95Ms).toBe(20_000)
    expect(r.leadToCard.count).toBe(1)
    expect(r.leadToCard.p90Ms).toBe(30_000)
  })

  it('FR-ANL-3: a card brought from the summary is not a lead-to-card time', async () => {
    await journal([
      { type: 'lead.found', sec: 0 },
      { type: 'task.created', sec: 8 * 3600, payload: { via: 'summary' } },
    ])
    expect((await speedReport(db)).leadToCard.count).toBe(0)
  })
})
