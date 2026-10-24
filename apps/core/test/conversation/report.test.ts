import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { moscowDayStart } from '../../src/conversation/cards'
import { daySummary } from '../../src/conversation/daySummary'
import { convReport } from '../../src/conversation/report'
import { ensureConversation } from '../../src/conversation/store'
import { convTurn } from '../../src/db/schema'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)
let sent: string[]
const notifier = {
  sendText: async (t: string) => {
    sent.push(t)
    return { messageId: 1 }
  },
}

beforeEach(async () => {
  await resetDb(db)
  sent = []
})

async function turns(convId: string) {
  const base = { conversationId: convId, anchorMessageId: 'm', state: 'finished' }
  await db.insert(convTurn).values([
    {
      ...base,
      id: 't-1',
      outcome: 'drafted',
      cardMessageId: 10,
      actualMessageId: 'a',
      actualAuthor: 'unknown',
      similarity: 40,
      checks: { issues: [{ id: 'dash', detail: 'тире' }] },
      understanding: { topic: 'process', tone: 'doubt' },
    },
    {
      ...base,
      id: 't-2',
      outcome: 'called_boris',
      cardMessageId: 11,
      actualMessageId: 'b',
      actualAuthor: 'boris',
      similarity: 60,
      understanding: { topic: 'price', tone: 'neutral' },
    },
    { ...base, id: 't-3', outcome: 'drafted', checks: { issues: [], failure: 'cli_failed' } },
  ])
}

describe('the conversation report', () => {
  it('FR-OPS-4: the report counts drafts, comparisons by author and check failures', async () => {
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: 'c-1',
      orderId: null,
    })
    await turns(conv.id)
    const text = await convReport(db, 7)
    expect(text).toContain('Ходов: 3')
    expect(text).toContain('черновиков 2')
    expect(text).toContain('позвала бы тебя 1')
    expect(text).toContain('Карточек: 2')
    expect(text).toContain('Сравнений: 2 (Сара v1 или ты 1, ты 1), среднее сходство 50%')
    expect(text).toContain('dash 1')
    expect(text).toContain('Сбоев модели: 1')
    expect(text).not.toMatch(/[—–]/)
  })
})

describe('the evening conversation summary', () => {
  it('FR-NOTIF-3: the evening conversation summary comes once and not on an empty day', async () => {
    // 20:30 Moscow of today's Moscow day, the day the turns below are made in
    const evening = new Date(new Date(moscowDayStart(new Date())).getTime() + 20.5 * 3600_000)
    expect(await daySummary({ db, notifier }, evening)).toBe('empty')
    expect(sent).toHaveLength(0)
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: 'c-2',
      orderId: null,
    })
    await turns(conv.id)
    expect(await daySummary({ db, notifier }, evening)).toBe('sent')
    expect(await daySummary({ db, notifier }, evening)).toBe('already')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/Разговоры за день: 3 реплики клиентов/)
    expect(sent[0]).toMatch(/сходство 50%/)
    expect(await countEvents(db, 'conv.day_summary')).toBe(1)
  })

  it('FR-NOTIF-3: before 20:00 Moscow there is no summary yet', async () => {
    const morning = new Date(new Date(moscowDayStart(new Date())).getTime() + 9 * 3600_000)
    expect(await daySummary({ db, notifier }, morning)).toBe('not_yet')
  })
})
