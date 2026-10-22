import { type EventEnvelope, type NewEvent, newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { appendEvent, appendEventIfNew, listEvents } from '../src/journal/journal'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const leadFoundInput = (): NewEvent => ({
  type: 'lead.found',
  v: 1,
  entity: { kind: 'lead', id: '95147898' },
  account_id: 'hance-marketing',
  actor: 'sara',
  occurred_at: new Date().toISOString(),
  causation_id: null,
  correlation_id: newEventId(),
  reason: null,
  payload: { title: 'Сайт для клиники' },
})

describe('journal', () => {
  it('FR-OPS-4: appendEvent stores a C1 envelope and returns it with id', async () => {
    const e = await appendEvent(db, leadFoundInput())
    expect(e.id).toMatch(uuidV7)
    const [stored] = await listEvents(db, { correlationId: e.correlation_id })
    expect(stored).toEqual(e)
  })

  it('FR-OPS-4: appendEvent refuses an envelope that breaks the contract', async () => {
    await expect(
      appendEvent(db, { ...leadFoundInput(), type: 'lead.nope' } as unknown as NewEvent),
    ).rejects.toThrow()
  })

  it('FR-OPS-4: appendEventIfNew ignores a repeated id', async () => {
    const e: EventEnvelope = { ...leadFoundInput(), id: newEventId() }
    expect(await appendEventIfNew(db, e)).toBe(true)
    expect(await appendEventIfNew(db, e)).toBe(false)
  })
})
