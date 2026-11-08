import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { catchUpMissedTurns, startCatchUp } from '../../src/conversation/catchUp'
import { expectLastAfter } from '../../src/conversation/outbox'
import { ensureConversation, updateConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import { convTurn } from '../../src/db/schema'
import { setSetting } from '../../src/settings/store'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
let started: string[]
const start = async (c: { chatId: string }) => {
  started.push(c.chatId)
}
// From the real clock: startCatchUp looks back 7 days from the moment it runs, so a fixed date stopped finding the
// test's chat a week later (08.11.2026, every CI run touching conversations failed on it).
const NOW = new Date()
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()

/** A chat with these messages (author, minutes ago), stored as the sync stores them. */
async function chat(id: string, msgs: [string, 'client' | 'specialist' | 'system', number][]) {
  const conv = await ensureConversation(db, { accountId: ACC, chatId: id, orderId: id })
  await syncChat(
    { db, profi: stubProfi(msgs.map(([m, side, min]) => chatMsg(m, side, `text ${m}`, ago(min)))) },
    conv,
    NOW,
    { v1Writes: false },
  )
  return conv
}

beforeEach(async () => {
  await resetDb(db)
  started = []
  await setSetting(db, 'pipeline.conversations', true, 'system')
})

describe('the catch-up of missed turns', () => {
  it('FR-CONV-7: a client word hidden by the site line, with no turn, gets its turn; one that was answered or has a turn does not', async () => {
    await chat('1001', [
      ['a1', 'specialist', 600],
      ['a2', 'client', 300],
      ['a3', 'system', 299],
    ])
    await chat('1002', [
      ['b1', 'specialist', 600],
      ['b2', 'client', 300],
      ['b3', 'specialist', 200],
    ])
    const had = await chat('1003', [
      ['c1', 'specialist', 600],
      ['c2', 'client', 300],
      ['c3', 'system', 299],
    ])
    await db.insert(convTurn).values({
      id: newEventId(),
      conversationId: had.id,
      anchorMessageId: 'c2',
      messageIds: ['c2'],
      state: 'decided',
    })
    expect(await catchUpMissedTurns({ db, start }, NOW)).toBe(1)
    expect(started).toEqual(['1001'])
  })

  it('FR-CONV-7: Boris’s own clients, closed conversations, old words and a switched-off pipeline are left alone', async () => {
    const taken = await chat('2001', [
      ['a1', 'client', 300],
      ['a2', 'system', 299],
    ])
    await updateConversation(db, taken.id, { owner: 'boris', ownerReason: 'take' })
    const closed = await chat('2002', [
      ['b1', 'client', 300],
      ['b2', 'system', 299],
    ])
    await updateConversation(db, closed.id, { closedAt: ago(10) })
    await chat('2003', [['c1', 'client', 20 * 24 * 60]])
    expect(await catchUpMissedTurns({ db, start }, NOW)).toBe(0)
    await chat('2004', [
      ['d1', 'client', 300],
      ['d2', 'system', 299],
    ])
    await setSetting(db, 'pipeline.conversations', false, 'system')
    expect(await catchUpMissedTurns({ db, start }, NOW)).toBe(0)
    expect(started).toEqual([])
  })

  it('FR-CONV-7: no more than five turns a pass', async () => {
    for (let k = 0; k < 7; k++)
      await chat(`300${k}`, [
        [`m${k}a`, 'client', 300 - k],
        [`m${k}b`, 'system', 290 - k],
      ])
    expect(await catchUpMissedTurns({ db, start }, NOW)).toBe(5)
  })
})

describe('what the node must still see when a draft goes', () => {
  it('FR-CONV-9: the site line behind the client’s word is the last message to expect; a word of anyone’s after it is not', async () => {
    const conv = await chat('4001', [
      ['a1', 'specialist', 600],
      ['a2', 'client', 300],
      ['a3', 'system', 299],
    ])
    expect(await expectLastAfter(db, conv.id, 'a2')).toBe('a3')
    const moved = await chat('4002', [
      ['b1', 'client', 300],
      ['b2', 'system', 299],
      ['b3', 'client', 200],
    ])
    expect(await expectLastAfter(db, moved.id, 'b1')).toBe('b1')
    const plain = await chat('4003', [['c1', 'client', 300]])
    expect(await expectLastAfter(db, plain.id, 'c1')).toBe('c1')
    expect(await expectLastAfter(db, plain.id, null)).toBeUndefined()
  })
})

describe('a turn cut short by plumbing', () => {
  const failedTurn = async (convId: string, anchor: string, id: string, minAgo: number) =>
    db.insert(convTurn).values({
      id,
      conversationId: convId,
      anchorMessageId: anchor,
      messageIds: [anchor],
      state: 'finished',
      decision: 'draft',
      decisionReason: 'не могу прочитать чат',
      outcome: 'failed',
      finishedAt: ago(minAgo),
    })

  it('FR-CONV-2: it is taken again after a few minutes, not at once, not forever, and a real draft is left alone', async () => {
    const a = await chat('5001', [
      ['a1', 'client', 300],
      ['a2', 'system', 299],
    ])
    await failedTurn(a.id, 'a1', 't-a1', 10)
    const fresh = await chat('5002', [
      ['b1', 'client', 300],
      ['b2', 'system', 299],
    ])
    await failedTurn(fresh.id, 'b1', 't-b1', 1)
    const tired = await chat('5003', [
      ['c1', 'client', 300],
      ['c2', 'system', 299],
    ])
    for (const k of [1, 2, 3]) await failedTurn(tired.id, 'c1', `t-c${k}`, 60 * k)
    const real = await chat('5004', [
      ['d1', 'client', 300],
      ['d2', 'system', 299],
    ])
    await db.insert(convTurn).values({
      id: 't-d1',
      conversationId: real.id,
      anchorMessageId: 'd1',
      messageIds: ['d1'],
      state: 'finished',
      decision: 'draft',
      decisionReason: 'отправлю по нажатию',
      text: 'Добрый день!',
      outcome: 'drafted',
      finishedAt: ago(100),
    })
    expect(await catchUpMissedTurns({ db, start }, NOW)).toBe(1)
    expect(started).toEqual(['5001'])
  })

  it('FR-CONV-2: the first pass waits for the node, and a later one runs only when it answers', async () => {
    await chat('6001', [
      ['a1', 'client', 300],
      ['a2', 'system', 299],
    ])
    let asks = 0
    const up = false
    const c = startCatchUp(
      { db, ready: async () => (++asks >= 3 ? true : up), start },
      { tries: 10, everyMs: 20, repeatMs: 60 },
    )
    await new Promise((r) => setTimeout(r, 400))
    c.stop()
    expect(asks).toBeGreaterThanOrEqual(3)
    expect(started.length).toBeGreaterThanOrEqual(1)
    expect(new Set(started)).toEqual(new Set(['6001']))
  })
})
