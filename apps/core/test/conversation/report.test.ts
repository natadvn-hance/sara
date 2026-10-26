import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { moscowDayStart } from '../../src/conversation/cards'
import { daySummary } from '../../src/conversation/daySummary'
import { convReport } from '../../src/conversation/report'
import { ensureConversation } from '../../src/conversation/store'
import { chatMessage, convTurn, jobRun } from '../../src/db/schema'
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
    expect(text).not.toMatch(/[\u2014\u2013]/)
  })
})

/** Reminders of one anchor, as the process leaves them: two drafts in shadow, a dormant day, and others after the switch. */
async function reminders(convId: string) {
  const base = {
    conversationId: convId,
    kind: 'reminder',
    anchorMessageId: 'm-0',
    state: 'finished',
  }
  await db.insert(convTurn).values([
    {
      ...base,
      id: 'conv-remind:c:m-0:1',
      outcome: 'drafted',
      text: 'Анна, здравствуйте! Как у вас дела с сайтом?',
      understanding: { step: 1, tone: 'check_in', read: false },
      createdAt: '2026-10-25T10:00:00.000Z',
    },
    {
      ...base,
      id: 'conv-remind:c:m-0:2',
      outcome: 'drafted',
      text: 'Анна, добрый день! Сайт ещё в планах?',
      understanding: { step: 2, tone: 'check_in', read: false },
      createdAt: '2026-10-25T11:00:00.000Z',
    },
    {
      ...base,
      id: 'conv-remind:c:m-0:dormant',
      outcome: 'dormant',
      understanding: { step: 'dormant', tone: 'check_in' },
    },
    { ...base, id: 'conv-remind:d:m-0:1', outcome: 'sent', understanding: { step: 1 } },
    { ...base, id: 'conv-remind:e:m-0:1', outcome: 'skipped', understanding: { step: 1 } },
    { ...base, id: 'conv-remind:f:m-0:1', outcome: 'stopped', understanding: { step: 1 } },
  ])
}

describe('reminders in the conversation report', () => {
  it('FR-CONV-12: reminders are not turns, and the report shows what Sara would have sent beside what went', async () => {
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: 'c-9',
      orderId: null,
    })
    await turns(conv.id)
    await reminders(conv.id)
    await db.insert(chatMessage).values({
      id: newEventId(),
      accountId: 'hance-marketing',
      chatId: 'c-9',
      platformMessageId: 'v1-1',
      side: 'specialist',
      author: 'unknown',
      authorBasis: 'v1_or_boris',
      text: 'Анна, здравствуйте! Как успехи с сайтом?',
      sentAt: '2026-10-25T10:05:00.000Z',
      source: 'node',
      conversationId: conv.id,
    })
    const text = await convReport(db, 7, new Date('2026-10-26T10:00:00.000Z'))
    // The same three turns as without reminders.
    expect(text).toContain('Ходов: 3')
    expect(text).toContain('Напоминания: 6')
    expect(text).toContain('черновиков в тени 2')
    expect(text).toContain('отправлено 1')
    expect(text).toContain('пропущено 1')
    expect(text).toContain('остановлено 1')
    expect(text).toContain('застоев 1')
    expect(text).toContain('шаг 1 4, шаг 2 1, застой 1')
    expect(text).toContain('Ответила бы: «Анна, здравствуйте! Как у вас дела с сайтом?»')
    expect(text).toContain('Ушло потом (Сара v1 или ты')
    expect(text).toContain('«Анна, здравствуйте! Как успехи с сайтом?»')
    expect(text).toMatch(/Ушло потом: пока ничего/)
    expect(text).not.toMatch(/[\u2014\u2013]/)
  })

  it('FR-CONV-12: in drafts mode the report counts the cards, the presses and what Boris declined', async () => {
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: 'c-10',
      orderId: null,
    })
    const base = {
      conversationId: conv.id,
      kind: 'reminder',
      anchorMessageId: 'm-0',
      state: 'finished',
    }
    await db.insert(convTurn).values([
      { ...base, id: 'conv-remind:g:m-0:1', outcome: 'carded', understanding: { step: 1 } },
      { ...base, id: 'conv-remind:h:m-0:1', outcome: 'sent', understanding: { step: 1 } },
      { ...base, id: 'conv-remind:i:m-0:1', outcome: 'declined', understanding: { step: 1 } },
      { ...base, id: 'conv-remind:j:m-0:1', outcome: 'expired', understanding: { step: 1 } },
      { ...base, id: 'conv-remind:k:m-0:1', outcome: 'answered', understanding: { step: 1 } },
    ])
    const text = await convReport(db, 7)
    expect(text).toContain('Напоминания: 5')
    expect(text).toContain('карточек Борису, ждут ответа 1')
    expect(text).toContain('отправлено 1')
    expect(text).toContain('Борис сказал «не надо» 1')
    expect(text).toContain('устарело 2')
    expect(text).not.toMatch(/[\u2014\u2013]/)
  })

  it('FR-CONV-12: a report without reminders says so in one line', async () => {
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: 'c-8',
      orderId: null,
    })
    await turns(conv.id)
    expect(await convReport(db, 7)).toContain('Напоминания: нет.')
  })

  it('FR-NOTIF-3: a day with only reminders is an empty day for the evening summary', async () => {
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: 'c-7',
      orderId: null,
    })
    await reminders(conv.id)
    const evening = new Date(new Date(moscowDayStart(new Date())).getTime() + 20.5 * 3600_000)
    expect(await daySummary({ db, notifier }, evening)).toBe('empty')
    expect(sent).toHaveLength(0)
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

  it('FR-NOTIF-3: the summary’s day is the Moscow date, not the UTC date of the Moscow midnight', async () => {
    const evening = new Date(new Date(moscowDayStart(new Date())).getTime() + 20.5 * 3600_000)
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: 'c-3',
      orderId: null,
    })
    await turns(conv.id)
    expect(await daySummary({ db, notifier }, evening)).toBe('sent')
    const [row] = await db.select().from(jobRun)
    expect(row?.day).toBe(evening.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }))
  })

  it('FR-NOTIF-3: before 20:00 Moscow there is no summary yet', async () => {
    const morning = new Date(new Date(moscowDayStart(new Date())).getTime() + 9 * 3600_000)
    expect(await daySummary({ db, notifier }, morning)).toBe('not_yet')
  })
})
