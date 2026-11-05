import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import { historyOf, restoreNext, restoreTopic } from '../../src/conversation/topicRestore'
import { chatMessage, forumTopic, lead } from '../../src/db/schema'
import { appendEvent } from '../../src/journal/journal'
import { shownRefs, topicName } from '../../src/notify/forum'
import type { Notifier } from '../../src/notify/notifier'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const ORDER = '95498816'
const ACC = 'hance-marketing'
let sent: { html: string; place: unknown; quiet: boolean | undefined }[]
let edits: { ref: number; html: string }[]
let posts: number[]
let forum = true
const notifier: Pick<Notifier, 'sendText' | 'editText' | 'topicPosts' | 'forumOn'> = {
  sendText: async (html, o) => {
    sent.push({ html, place: o?.place, quiet: o?.quiet })
    return { messageId: -(900 + sent.length) }
  },
  editText: async (ref, html) => {
    edits.push({ ref, html })
  },
  topicPosts: async () => posts,
  forumOn: async () => forum,
}
const deps = { db, notifier, pauseMs: 0 }
const at = (iso: string) => new Date(iso).toISOString()

async function event(
  type: 'bid.sent' | 'bid.series_sent',
  when: string,
  payload: Record<string, unknown>,
) {
  await appendEvent(db, {
    type,
    v: 1,
    entity: { kind: 'lead', id: ORDER },
    account_id: ACC,
    actor: 'sara',
    occurred_at: at(when),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload,
  })
}

/** The chat of the order as the sync stores it. */
async function chat(msgs: [string, 'client' | 'specialist' | 'system', string, string][]) {
  const conv = await ensureConversation(db, { accountId: ACC, chatId: ORDER, orderId: ORDER })
  await syncChat(
    {
      db,
      profi: stubProfi(msgs.map(([id, side, text, when]) => chatMsg(id, side, text, at(when)))),
    },
    conv,
    new Date('2026-11-01T10:00:00Z'),
    { v1Writes: false },
  )
  return conv
}

beforeEach(async () => {
  await resetDb(db)
  sent = []
  edits = []
  posts = []
  forum = true
  await db.insert(lead).values({
    id: ORDER,
    accountId: ACC,
    title: 'Нужен сайт',
    category: 'Сайты',
    city: 'Краснодар',
    text: 'Нужен сайт для клиники · Срок: месяц',
    clientName: 'Роберт',
    bidPriceRub: 290,
    seenAt: at('2026-10-28T12:30:00Z'),
    correlationId: newEventId(),
    status: 'bid_sent',
    draftText: 'Роберт, добрый день! Понимаю задачу.',
    draftPriceRub: 60000,
    draftPriceToRub: 90000,
    draftFollowUps: ['Из недавнего: кейс', 'Сделаем быстро'],
  })
  await event('bid.sent', '2026-10-28T12:39:00Z', { spent_rub: 290 })
  await event('bid.series_sent', '2026-10-31T14:12:05Z', { n: 0 })
})

describe('the history of a topic', () => {
  it('ST-M7-16: the bid, the series and the chat in order, each with its real date', async () => {
    await chat([
      ['m1', 'specialist', 'Роберт, добрый день! Понимаю задачу.', '2026-10-28T12:39:02Z'],
      ['m2', 'specialist', 'Из недавнего: кейс', '2026-10-31T14:12:06Z'],
      ['m3', 'client', 'Покажите примеры', '2026-10-31T15:00:00Z'],
      ['m4', 'system', 'Сообщите, если договоритесь', '2026-10-31T15:00:01Z'],
    ])
    const items = await historyOf(db, ORDER)
    expect(items.map((i) => i.ref)).toEqual(['bid', 'series:1', 'msg:m3'])
    expect(items[0]?.html).toContain('28 октября, 15:39')
    expect(items[0]?.html).toContain('от 60')
    expect(items[1]?.html).toContain('Вдогонку 1 из 2')
    expect(items[1]?.html).toContain('31 октября, 17:12')
    expect(items[2]?.html).toContain('31 октября, 18:00')
  })

  it('ST-M7-16: without a chat the bid and the series come from the journal and the draft', async () => {
    const items = await historyOf(db, ORDER)
    expect(items.map((i) => i.ref)).toEqual(['bid', 'series:1'])
    expect(items[1]?.html).toContain('Из недавнего: кейс')
  })
})

describe('the restore of a topic', () => {
  it('ST-M7-16: a bid with no topic gets one, with the note first and then its history, quietly and once', async () => {
    await chat([['m3', 'client', 'Покажите примеры', '2026-10-31T15:00:00Z']])
    expect(await restoreNext(deps, new Date('2026-11-01T10:00:00Z'))).toBe(ORDER)
    expect(sent[0]?.html).toContain('Тема открыта позже')
    expect(sent.map((s) => s.place)).toEqual(Array(sent.length).fill({ order: ORDER }))
    expect(sent.every((s) => s.quiet)).toBe(true)
    expect(sent.slice(1).map((s) => s.html.split('\n')[0])).toEqual([
      expect.stringContaining('Отклик отправлен'),
      expect.stringContaining('Вдогонку 1 из 2'),
      expect.stringContaining('Роберт'),
    ])
    const refs = await shownRefs(db, ORDER)
    expect([...refs].sort()).toEqual(['bid', 'msg:m3', 'restored', 'series:1'])
    // Nothing twice.
    sent = []
    await db.insert(forumTopic).values({ chatId: -1001, key: ORDER, threadId: 7, name: 'Роберт' })
    expect(await restoreNext(deps, new Date('2026-11-01T10:00:00Z'))).toBeNull()
    expect(sent).toEqual([])
  })

  it('ST-M7-16: an old topic keeps its posts: the first is laid out anew, the old bid post is rewritten, the rest is added', async () => {
    await chat([['m3', 'client', 'Покажите примеры', '2026-10-31T15:00:00Z']])
    await db.insert(forumTopic).values({
      chatId: -1001,
      key: ORDER,
      threadId: 7,
      name: topicName({ name: 'Роберт', orderId: ORDER, title: 'Нужен сайт' }),
      createdAt: at('2026-11-01T15:32:00Z'),
    })
    posts = [-11, -12]
    expect(await restoreTopic(deps, ORDER, { fresh: false })).toBe('done')
    expect(edits.map((e) => e.ref)).toEqual([-11, -12])
    expect(edits[0]?.html).toContain('📌 <b>Нужен сайт</b>')
    expect(edits[1]?.html).toContain('Отклик отправлен')
    expect(edits[1]?.html).toContain('28 октября, 15:39')
    // The bid is not posted again; the series and the client’s words are added after the note.
    expect(sent.map((s) => s.html.split('\n')[0])).toEqual([
      expect.stringContaining('Тема открыта позже'),
      expect.stringContaining('Вдогонку 1 из 2'),
      expect.stringContaining('Роберт'),
    ])
  })

  it('ST-M7-16: where newer messages are shown already and older ones are missing, nothing is added', async () => {
    await chat([['m3', 'client', 'Покажите примеры', '2026-11-01T16:00:00Z']])
    await db.insert(forumTopic).values({
      chatId: -1001,
      key: ORDER,
      threadId: 7,
      name: 'Роберт',
      createdAt: at('2026-11-01T15:32:00Z'),
    })
    posts = [-11, -12, -13]
    expect(await restoreTopic(deps, ORDER, { fresh: false })).toBe('skipped')
    expect(sent).toEqual([])
    expect(edits.map((e) => e.ref)).toEqual([-11])
    expect((await shownRefs(db, ORDER)).has('restored')).toBe(true)
  })

  it('ST-M7-16: nothing without a forum', async () => {
    forum = false
    expect(await restoreNext(deps)).toBeNull()
    expect(sent).toEqual([])
    expect(await db.select().from(chatMessage).where(eq(chatMessage.chatId, ORDER))).toEqual([])
  })
})
