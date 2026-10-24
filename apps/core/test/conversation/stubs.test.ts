import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, mindProposal, outbox } from '../../src/db/schema'
import { isBidRow, resumeQueuedOutbox } from '../../src/leads/outbox'
import { proposeMind } from '../../src/mind/proposals'
import { createMindSearch } from '../../src/mind/search'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

describe('M4 part 0', () => {
  it('NFR-REL-4: a queued message outbox row is not resumed as a bid', async () => {
    await db.insert(outbox).values({
      id: newEventId(),
      kind: 'message',
      idempotencyKey: 'msg:turn:1',
      payload: { chatId: '95147898', text: 'Добрый день' },
    })
    expect(await resumeQueuedOutbox(db)).toBe(0)
  })

  it('FR-MIND-3: a proposal is stored once and journaled', async () => {
    const p = {
      path: 'mind/proposals/shared/speech/examples/e-h-1.md',
      content: '---\nid: e-h-1\n---\n',
      kind: 'example' as const,
      source: 'history:hance-marketing:1',
    }
    expect(await proposeMind(db, p)).toBe(true)
    expect(await proposeMind(db, { ...p, content: 'другое' })).toBe(false)
    expect(await db.select().from(mindProposal)).toHaveLength(1)
    expect(await countEvents(db, 'mind.proposed')).toBe(1)
    const [e] = await db.select().from(event).where(eq(event.type, 'mind.proposed'))
    expect(JSON.stringify(e?.payload)).not.toMatch(/e-h-1|id:/)
  })

  it('NFR-REL-4: bid delivery never takes a message row', async () => {
    expect(isBidRow({ kind: 'message', state: 'queued' })).toBe(false)
    expect(isBidRow({ kind: 'bid', state: 'queued' })).toBe(true)
    expect(isBidRow({ kind: 'bid', state: 'confirmed' })).toBe(false)
  })

  it('FR-MIND-2: the empty mind answers nothing until part B lands', async () => {
    const mind = createMindSearch(db)
    expect(
      await mind.search({ text: 'цена', scope: 'shared', types: ['knowledge'], limit: 5 }),
    ).toEqual([])
  })
})
