import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sendTurnCard } from '../../src/conversation/cards'
import { compareAfterTurn, compareTurn, similarity } from '../../src/conversation/compare'
import { ensureConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import { CONV_TEXTS } from '../../src/conversation/texts'
import { chatMessage, convTurn, lead, task } from '../../src/db/schema'
import type { Notifier } from '../../src/notify/notifier'
import { setSetting } from '../../src/settings/store'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)

type Sent = {
  text: string
  rows: { text: string; callbackData: string }[][]
  loud: boolean
  id: number
}
let sent: Sent[]
let edits: { id: number; text: string; rows?: { text: string; callbackData: string }[][] }[]
const notifier: Pick<Notifier, 'sendButtons' | 'editText'> = {
  sendButtons: async (text, rows, o) => {
    sent.push({ text, rows, loud: o?.loud ?? false, id: 100 + sent.length })
    return { messageId: 100 + sent.length - 1 }
  },
  editText: async (id, text, rows) => {
    edits.push({ id, text, rows })
  },
}

const CHAT = '95147898'
let convId: string

beforeEach(async () => {
  await resetDb(db)
  sent = []
  edits = []
  await setSetting(db, 'cards.quiet_hours', null, 'system')
  await db.insert(lead).values({
    id: CHAT,
    accountId: 'hance-marketing',
    title: 'Сайт для клиники',
    category: 'Сайты',
    city: 'Краснодар',
    text: 'Нужен сайт',
    clientName: 'Анна',
    bidPriceRub: 100,
    seenAt: new Date().toISOString(),
    correlationId: newEventId(),
  })
  const conv = await ensureConversation(db, {
    accountId: 'hance-marketing',
    chatId: CHAT,
    orderId: CHAT,
  })
  convId = conv.id
  await syncChat(
    {
      db,
      profi: stubProfi([
        chatMsg('m-2', 'client', 'Сколько стоит и когда начнём?', new Date().toISOString()),
      ]),
    },
    conv,
    new Date(),
    { v1Writes: true },
  )
})

async function turn(id: string, o: Partial<typeof convTurn.$inferInsert> = {}) {
  await db.insert(convTurn).values({
    id,
    conversationId: convId,
    anchorMessageId: 'm-2',
    messageIds: ['m-2'],
    state: 'decided',
    move: 'reply',
    text: 'Анна, здравствуйте. Начнём с короткого созвона, чтобы понять задачу.',
    factIds: ['k-process-start'],
    exampleIds: ['e-1'],
    understanding: { topic: 'process', tone: 'doubt' },
    decision: 'draft',
    decisionReason: 'режим тени; сама бы: отправила бы',
    ...o,
  })
}

describe('the draft card', () => {
  it('FR-CONV-3: the draft card shows the draft, what Sara would do and the mind ids', async () => {
    await turn('t-1')
    const r = await sendTurnCard({ db, notifier }, 't-1')
    expect(r).not.toBeNull()
    const card = sent[0]
    expect(card?.text).toContain('Анна')
    expect(card?.text).toContain('Сайт для клиники')
    expect(card?.text).toContain('Сколько стоит и когда начнём?')
    expect(card?.text).toContain('Начнём с короткого созвона')
    expect(card?.text).toContain('k-process-start')
    expect(card?.text).toContain('сомнение')
    expect(card?.text).toMatch(/Режим тени: клиенту ничего не ушло/)
    const actions = card?.rows.flat().map((b) => b.callbackData.split(':')[2])
    expect(actions).toEqual(['good', 'edit', 'take', 'close'])
    const [t] = await db.select().from(task)
    expect(t).toMatchObject({
      kind: 'conv_draft',
      entityKind: 'conv_turn',
      entityId: 't-1',
      state: 'open',
    })
    const [row] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
    expect(row?.cardMessageId).toBe(r?.messageId)
    expect(row?.taskId).toBe(t?.id)
  })

  it('FR-NOTIF-3: the 11th card of the day is not sent, a call for Boris still is', async () => {
    for (let i = 0; i < 11; i++) {
      await turn(`t-${i}`)
      await sendTurnCard({ db, notifier }, `t-${i}`)
    }
    expect(sent).toHaveLength(10)
    await turn('t-call', {
      decision: 'call_boris',
      move: 'call_boris',
      text: null,
      decisionReason: 'клиент просит созвон',
    })
    expect(await sendTurnCard({ db, notifier }, 't-call')).not.toBeNull()
    expect(sent).toHaveLength(11)
    expect(sent[10]?.text).toMatch(/просит созвон/)
  })

  it('NFR-UX-1: conversation texts have no long dash', async () => {
    await turn('t-1', { text: 'Да \u2014 начнём' })
    await sendTurnCard({ db, notifier }, 't-1')
    expect(sent[0]?.text).not.toMatch(/[\u2014\u2013]/)
  })

  it('NFR-UX-1: the quoted outside text of the comparison and the forward has no long dash either', () => {
    const dashes = /[\u2014\u2013]/
    expect(
      CONV_TEXTS.compared('14:32', 'boris', 'Анна \u2014 добрый день \u2013 созвонимся', 50),
    ).not.toMatch(dashes)
    expect(
      CONV_TEXTS.forward(
        'Анна \u2014 Мария',
        'Сайт \u2014 клиника',
        'Нет \u2013 да \u2014 ещё',
        true,
      ),
    ).not.toMatch(dashes)
  })
})

describe('comparison in shadow', () => {
  it('FR-CONV-10: Sara’s own sent message is never the real reply of an older draft', async () => {
    await turn('t-1', {
      state: 'finished',
      outcome: 'drafted',
      finishedAt: new Date().toISOString(),
    })
    await sendTurnCard({ db, notifier }, 't-1')
    const [own] = await db
      .insert(chatMessage)
      .values({
        id: newEventId(),
        accountId: 'hance-marketing',
        chatId: CHAT,
        orderId: CHAT,
        platformMessageId: 'm-3',
        side: 'specialist',
        author: 'sara',
        authorBasis: 'outbox',
        text: 'Анна, давайте начнём с созвона.',
        sentAt: new Date().toISOString(),
        source: 'node',
        conversationId: convId,
      })
      .returning()
    await compareTurn({ db, notifier }, convId, [own as never])
    const [row] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
    expect(row?.actualMessageId).toBeNull()
    expect(edits).toHaveLength(0)
  })

  it('FR-CONV-10: the real reply edits the card silently with its author and similarity', async () => {
    await turn('t-1', {
      state: 'finished',
      outcome: 'drafted',
      finishedAt: new Date().toISOString(),
    })
    await sendTurnCard({ db, notifier }, 't-1')
    const [actual] = await db
      .insert(chatMessage)
      .values({
        id: newEventId(),
        accountId: 'hance-marketing',
        chatId: CHAT,
        orderId: CHAT,
        platformMessageId: 'm-3',
        side: 'specialist',
        author: 'unknown',
        authorBasis: 'v1_or_boris',
        text: 'Анна, здравствуйте. Давайте начнём с созвона.',
        sentAt: new Date().toISOString(),
        source: 'node',
        conversationId: convId,
      })
      .returning()
    await compareTurn({ db, notifier }, convId, [actual as never])
    const [row] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
    expect(row?.actualMessageId).toBe('m-3')
    expect(row?.actualAuthor).toBe('unknown')
    expect(row?.similarity).toBeGreaterThan(20)
    expect(edits).toHaveLength(1)
    expect(edits[0]?.text).toMatch(/Ушло клиенту в \d\d:\d\d \(Сара v1 или ты\)/)
    expect(edits[0]?.text).toMatch(/Сходство с моим: \d+%/)
    expect(edits[0]?.rows?.flat().length).toBe(4)
    expect(await countEvents(db, 'conv.compared')).toBe(1)
    // A second message of our side does not compare the same turn again.
    await compareTurn({ db, notifier }, convId, [actual as never])
    expect(edits).toHaveLength(1)
  })

  const ours = (id: string, author: 'sara' | 'unknown' | 'boris', text: string, at: Date) =>
    db.insert(chatMessage).values({
      id: newEventId(),
      accountId: 'hance-marketing',
      chatId: CHAT,
      orderId: CHAT,
      platformMessageId: id,
      side: 'specialist',
      author,
      authorBasis:
        author === 'sara' ? 'outbox' : author === 'boris' ? 'after_cutover' : 'v1_or_boris',
      text,
      sentAt: at.toISOString(),
      source: 'node',
      conversationId: convId,
    })

  it('FR-CONV-10: the comparison after a running turn takes the first message of our side that is not Sara’s', async () => {
    await turn('t-1', { state: 'decided' })
    await sendTurnCard({ db, notifier }, 't-1')
    const now = Date.now()
    await ours('m-3', 'sara', 'Мой старый ответ', new Date(now + 1000))
    await ours('m-4', 'unknown', 'Анна, давайте начнём с созвона.', new Date(now + 2000))
    await ours('m-5', 'unknown', 'И ещё одно сообщение', new Date(now + 3000))
    const heard = {
      side: 'specialist',
      platformMessageId: 'm-5',
      author: 'unknown',
      text: 'И ещё одно сообщение',
      sentAt: new Date().toISOString(),
      accountId: 'hance-marketing',
    } as never
    // The event finds the turn still running and leaves it to the turn's own step.
    await compareTurn({ db, notifier }, convId, [heard])
    expect(edits).toHaveLength(0)
    await compareAfterTurn({ db, notifier }, 't-1')
    const [row] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
    expect(row?.actualMessageId).toBe('m-4')
    expect(row?.actualAuthor).toBe('unknown')
    expect(edits).toHaveLength(1)
    expect(await countEvents(db, 'conv.compared')).toBe(1)
    // A turn compared once is never compared twice, by this way or by the event.
    await compareAfterTurn({ db, notifier }, 't-1')
    await db.update(convTurn).set({ outcome: 'drafted' })
    await compareTurn({ db, notifier }, convId, [heard])
    expect(edits).toHaveLength(1)
    expect(await countEvents(db, 'conv.compared')).toBe(1)
  })

  it('FR-CONV-10: after the switch Boris’s own reply closes the card, which is redrawn without buttons', async () => {
    await setSetting(db, 'conv.v1_writes', false, 'system')
    await turn('t-1', {
      state: 'finished',
      outcome: 'drafted',
      finishedAt: new Date().toISOString(),
    })
    const card = await sendTurnCard({ db, notifier }, 't-1')
    await ours('m-3', 'boris', 'Анна, давайте начнём с созвона.', new Date(Date.now() + 2000))
    const [actual] = await db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.platformMessageId, 'm-3'))
    await compareTurn({ db, notifier }, convId, [actual as never])
    expect(edits).toHaveLength(1)
    expect(edits[0]?.text).toMatch(/Ты ответил сам/)
    expect(edits[0]?.rows).toEqual([])
    const [t] = await db
      .select()
      .from(task)
      .where(eq(task.id, card?.taskId ?? ''))
    expect(t).toMatchObject({ state: 'resolved', resolution: 'answered' })
  })

  it('FR-CONV-10: nothing is compared while no message of our side follows, and never after the switch', async () => {
    await turn('t-1', { state: 'decided' })
    await sendTurnCard({ db, notifier }, 't-1')
    await compareAfterTurn({ db, notifier }, 't-1')
    expect(edits).toHaveLength(0)
    await ours('m-4', 'unknown', 'Анна, давайте начнём с созвона.', new Date(Date.now() + 2000))
    await setSetting(db, 'conv.v1_writes', false, 'system')
    await compareAfterTurn({ db, notifier }, 't-1')
    expect(edits).toHaveLength(0)
  })

  it('FR-CONV-10: similarity of the same text is 100 and of unrelated texts near 0', () => {
    expect(similarity('Давайте созвонимся завтра', 'давайте  созвонимся завтра!')).toBe(100)
    expect(similarity('абв', 'где')).toBe(0)
  })
})
