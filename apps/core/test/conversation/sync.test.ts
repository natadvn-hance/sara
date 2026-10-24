import { type ChatMessage, newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyOwnerRule, ensureConversation, getConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import { chatMessage, deal, event, lead, outbox } from '../../src/db/schema'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const ACC = 'hance-marketing'
const CHAT = '95147898'
const bid = chatMsg(
  'm-1',
  'specialist',
  'Анна, добрый день! Понимаю задачу.',
  '2026-10-20T09:00:00.000Z',
)
const ask = chatMsg('m-2', 'client', 'Сколько стоит?', '2026-10-20T10:00:00.000Z')
const shadow = { v1Writes: true }
const live = { v1Writes: false }

describe('chat sync', () => {
  it('FR-CONV-2: every stored message has an author, a basis and a side', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    const r = await syncChat({ db, profi: stubProfi([bid, ask]) }, conv, new Date(), shadow)
    expect(r.added.map((m) => [m.platformMessageId, m.side, m.author, m.authorBasis])).toEqual([
      ['m-1', 'specialist', 'unknown', 'v1_or_boris'],
      ['m-2', 'client', 'client', 'side'],
    ])
    expect(r.messages).toHaveLength(2)
    const rows = await db.select().from(chatMessage)
    expect(rows.every((m) => m.conversationId === conv.id && m.heardAt !== null)).toBe(true)
  })

  it('FR-CONV-2: a repeated sync adds nothing and keeps the client text out of the journal', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    const p = stubProfi([bid, ask])
    await syncChat({ db, profi: p }, conv, new Date(), shadow)
    const again = await syncChat({ db, profi: p }, conv, new Date(), shadow)
    expect(again.added).toEqual([])
    expect(again.messages).toHaveLength(2)
    expect(await countEvents(db, 'conv.message_heard')).toBe(2)
    const payloads = JSON.stringify((await db.select().from(event)).map((e) => e.payload))
    expect(payloads).not.toContain('Сколько стоит')
  })

  it('FR-CONV-12: the page’s read mark of our message is not trusted, only the read event', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    await syncChat({ db, profi: stubProfi([bid, ask]) }, conv, new Date(), shadow)
    const rows = await db.select().from(chatMessage).orderBy(chatMessage.platformMessageId)
    expect(rows.map((m) => [m.side, m.read])).toEqual([
      ['specialist', false],
      ['client', true],
    ])
  })

  it('FR-CONV-2: an unclear author is reported by the sync', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    const odd = chatMsg('m-3', 'unknown', 'что-то', '2026-10-20T10:01:00.000Z')
    const r = await syncChat({ db, profi: stubProfi([bid, ask, odd]) }, conv, new Date(), shadow)
    expect(r.unclear).toBe(true)
  })

  it('FR-CONV-2: the first reading of a chat marks what was there before as approximate time', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    const now = new Date('2026-10-20T10:00:30.000Z')
    await syncChat({ db, profi: stubProfi([bid, ask]) }, conv, now, shadow)
    const rows = await db.select().from(chatMessage).orderBy(chatMessage.platformMessageId)
    expect(rows.map((m) => m.approxTime)).toEqual([true, false])
  })

  it('FR-CONV-9: our own sent message is Sara’s, found by its text in the outbox', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    await db.insert(outbox).values({
      id: newEventId(),
      kind: 'message',
      idempotencyKey: 'msg:t:1',
      payload: { chatId: CHAT, accountId: ACC, text: 'Понимаю вас.  Давайте созвонимся?' },
      state: 'confirmed',
    })
    const ours = chatMsg(
      'm-4',
      'specialist',
      'Понимаю вас. Давайте созвонимся?',
      '2026-10-20T10:05:00.000Z',
    )
    const r = await syncChat({ db, profi: stubProfi([bid, ask, ours]) }, conv, new Date(), live)
    expect(r.added.find((m) => m.platformMessageId === 'm-4')).toMatchObject({
      author: 'sara',
      authorBasis: 'outbox',
    })
  })
})

describe('owner rule', () => {
  it('FR-CONV-10: in shadow a specialist message keeps the owner and is unknown', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    const r = await syncChat({ db, profi: stubProfi([bid, ask]) }, conv, new Date(), shadow)
    const after = await applyOwnerRule(db, conv, r.added, shadow)
    expect(after.owner).toBe('sara')
    expect(await countEvents(db, 'conv.boris_wrote')).toBe(0)
  })

  it('FR-CONV-10: after the switch a specialist message not in our outbox makes the client Boris’s', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    const p = stubProfi([bid, ask])
    await syncChat({ db, profi: p }, conv, new Date(), live)
    p.chat.push(
      chatMsg('m-5', 'specialist', 'Анна, давайте я вам наберу', '2026-10-20T10:07:00.000Z'),
    )
    const r = await syncChat({ db, profi: p }, conv, new Date(), live)
    expect(r.added).toHaveLength(1)
    expect(r.added[0]).toMatchObject({ author: 'boris', authorBasis: 'after_cutover' })
    const after = await applyOwnerRule(db, conv, r.added, live)
    expect(after).toMatchObject({ owner: 'boris', ownerReason: 'wrote' })
    expect((await getConversation(db, conv.id))?.owner).toBe('boris')
    expect(await countEvents(db, 'conv.boris_wrote')).toBe(1)
  })

  it('FR-CONV-10: after the switch the history of a chat read for the first time stays nobody’s', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    const r = await syncChat(
      { db, profi: stubProfi([bid, ask]) },
      conv,
      new Date('2026-10-20T10:00:30Z'),
      live,
    )
    expect(r.added[0]).toMatchObject({
      author: 'unknown',
      authorBasis: 'v1_or_boris',
      approxTime: true,
    })
    expect((await applyOwnerRule(db, conv, r.added, live)).owner).toBe('sara')
  })

  it('FR-CONV-10: Sara’s own message does not make the client Boris’s', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    const after = await applyOwnerRule(
      db,
      conv,
      [{ side: 'specialist', author: 'sara', authorBasis: 'outbox' }],
      live,
    )
    expect(after.owner).toBe('sara')
  })
})

describe('conversation', () => {
  it('FR-CONV-10: a chat of a bid the new Sara made links its deal', async () => {
    await db.insert(lead).values({
      id: CHAT,
      accountId: ACC,
      title: 'Сайт',
      category: 'Сайты',
      city: 'Краснодар',
      text: 'Нужен сайт',
      clientName: 'Анна',
      bidPriceRub: 100,
      seenAt: new Date().toISOString(),
      correlationId: newEventId(),
    })
    const dealId = newEventId()
    await db.insert(deal).values({ id: dealId, leadId: CHAT, accountId: ACC, stage: 'bid_sent' })
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    expect(conv).toMatchObject({ dealId, origin: 'sara', owner: 'sara' })
    const again = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: CHAT })
    expect(again.id).toBe(conv.id)
  })

  it('FR-CONV-10: a chat begun by old Sara has no deal', async () => {
    const conv = await ensureConversation(db, { accountId: ACC, chatId: CHAT, orderId: null })
    expect(conv).toMatchObject({ dealId: null, origin: 'v1' })
    const [row] = await db.select().from(deal).where(eq(deal.leadId, CHAT))
    expect(row).toBeUndefined()
  })
})
