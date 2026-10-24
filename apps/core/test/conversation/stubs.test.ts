import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { checkReplyText } from '../../src/conversation/check/codeChecks'
import { planTurn } from '../../src/conversation/engine'
import { mindProposal, outbox } from '../../src/db/schema'
import { resumeQueuedOutbox } from '../../src/leads/outbox'
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

  it('FR-CONV-4: the code checks stub blocks every reply', () => {
    const issues = checkReplyText({
      text: 'Добрый день',
      move: 'reply',
      factIds: ['j-constitution'],
      recalledIds: ['j-constitution'],
      knowledgeTexts: {},
      newDay: true,
      clientTurnText: 'Здравствуйте',
      ourPrevious: [],
      bannedPhrases: [],
    })
    expect(issues.length).toBeGreaterThan(0)
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
  })

  it('FR-MIND-2: the empty mind answers nothing until part B lands', async () => {
    const mind = createMindSearch(db)
    expect(
      await mind.search({ text: 'цена', scope: 'shared', types: ['knowledge'], limit: 5 }),
    ).toEqual([])
    await expect(planTurn({} as never, {} as never)).rejects.toThrow(/not built/)
  })
})
