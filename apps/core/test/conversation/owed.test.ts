import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  nextMorning,
  type OwedDeps,
  owedDueAt,
  owedPass,
  stepsAfterSend,
  waitedText,
} from '../../src/conversation/owed'
import { ensureConversation, updateConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import { chatMessage, convOwed, convTurn, lead, task } from '../../src/db/schema'
import { setSetting } from '../../src/settings/store'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const CHAT = '95504921'
const MIN = 60_000
let convId: string
let at: Date
let texts: { text: string; place: unknown; buttons: boolean; id: number }[]
let done: { id: number; note: string }[]
const notifier: OwedDeps['notifier'] = {
  sendText: async (text, o) => {
    texts.push({ text, place: o?.place, buttons: false, id: 500 + texts.length })
    return { messageId: 500 + texts.length - 1 }
  },
  sendButtons: async (text, _rows, o) => {
    texts.push({ text, place: o?.place, buttons: true, id: 500 + texts.length })
    return { messageId: 500 + texts.length - 1 }
  },
  markDone: async (id, note) => {
    done.push({ id, note })
  },
  topicLink: async () => 'https://t.me/c/1/2',
}
const deps: OwedDeps = { db, notifier }

/** A client message that came `agoMin` minutes before `at`. */
async function clientWrote(id: string, agoMin: number) {
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
        chatMsg(
          id,
          'client',
          'Наверно только звонки',
          new Date(at.getTime() - agoMin * MIN).toISOString(),
        ),
      ]),
    },
    conv,
    at,
    { v1Writes: false },
  )
}

beforeEach(async () => {
  await resetDb(db)
  texts = []
  done = []
  // 12:00 Moscow.
  at = new Date('2026-10-31T09:00:00.000Z')
  await setSetting(db, 'pipeline.conversations', true, 'system')
  await setSetting(db, 'conv.v1_writes', false, 'system')
  await db.insert(lead).values({
    id: CHAT,
    accountId: 'hance-marketing',
    title: 'Маркетинг',
    category: 'Маркетинг',
    city: 'Екатеринбург',
    text: 'Нужен маркетолог',
    clientName: 'Татьяна',
    bidPriceRub: 100,
    seenAt: at.toISOString(),
    correlationId: newEventId(),
  })
})

describe('the ladder', () => {
  it('FR-CONV-12: 30 minutes, 2 hours, then every morning at 9:00 Moscow', () => {
    const a = new Date('2026-10-31T09:00:00.000Z')
    expect(owedDueAt(a, 0, null).toISOString()).toBe('2026-10-31T09:30:00.000Z')
    expect(owedDueAt(a, 1, null).toISOString()).toBe('2026-10-31T11:00:00.000Z')
    // After the second one at 14:00 Moscow the next is 9:00 the next day.
    expect(owedDueAt(a, 2, new Date('2026-10-31T11:00:00.000Z')).toISOString()).toBe(
      '2026-11-01T06:00:00.000Z',
    )
    expect(nextMorning(new Date('2026-10-31T03:00:00.000Z')).toISOString()).toBe(
      '2026-10-31T06:00:00.000Z',
    )
  })

  it('FR-CONV-12: a rung already past is not sent again a minute later', () => {
    const a = new Date('2026-10-28T15:45:00.000Z')
    expect(stepsAfterSend(a, 0, new Date('2026-10-31T09:00:00.000Z'))).toBe(2)
    expect(stepsAfterSend(a, 0, new Date(a.getTime() + 31 * MIN))).toBe(1)
  })

  it('how long a client has waited reads short', () => {
    expect(waitedText(40 * MIN)).toBe('40 мин')
    expect(waitedText(150 * MIN)).toBe('3 ч')
    expect(waitedText(3 * 24 * 60 * MIN)).toBe('3 дня')
  })
})

describe('a client who waits', () => {
  it('FR-CONV-12: the reminder comes 30 minutes after the message, in the client topic, and replaces the last one', async () => {
    await clientWrote('m-1', 40)
    expect((await owedPass(deps, at)).reminded).toBe(1)
    expect(texts[0]?.text).toContain('⏰ <b>Татьяна</b> ждёт ответа 40 мин')
    expect(texts[0]?.place).toEqual({ conversation: convId })
    // Nothing more until the 2-hour rung.
    expect((await owedPass(deps, new Date(at.getTime() + 10 * MIN))).reminded).toBe(0)
    expect((await owedPass(deps, new Date(at.getTime() + 90 * MIN))).reminded).toBe(1)
    expect(done).toEqual([{ id: 500, note: 'Новое напоминание ниже' }])
    const [row] = await db.select().from(convOwed)
    expect(row?.steps).toBe(2)
  })

  it('FR-CONV-12: with an open draft the reminder carries the draft and its buttons', async () => {
    await clientWrote('m-1', 40)
    const taskId = newEventId()
    await db
      .insert(task)
      .values({ id: taskId, kind: 'conv_draft', entityKind: 'conv_turn', entityId: 't-1' })
    await db.insert(convTurn).values({
      id: 't-1',
      conversationId: convId,
      anchorMessageId: 'm-1',
      messageIds: ['m-1'],
      state: 'decided',
      text: 'Татьяна, здравствуйте. Расскажите, откуда сейчас идут клиенты?',
      decision: 'draft',
      taskId,
    })
    await owedPass(deps, at)
    expect(texts[0]?.buttons).toBe(true)
    expect(texts[0]?.text).toContain('✍️ Ответ Сары:')
    expect(texts[0]?.text).toContain('откуда сейчас идут клиенты')
  })

  it('FR-CONV-12: a new client message starts the ladder again', async () => {
    await clientWrote('m-1', 40)
    await owedPass(deps, at)
    await clientWrote('m-2', 5)
    expect((await owedPass(deps, at)).reminded).toBe(0)
    const later = new Date(at.getTime() + 26 * MIN)
    expect((await owedPass(deps, later)).reminded).toBe(1)
  })

  it('FR-CONV-12: taking the client or an answer stops the reminders and settles the last one', async () => {
    await clientWrote('m-1', 40)
    await owedPass(deps, at)
    await updateConversation(db, convId, { owner: 'boris', ownerReason: 'take' })
    expect((await owedPass(deps, new Date(at.getTime() + 3 * 60 * MIN))).reminded).toBe(0)
    expect(done.at(-1)).toEqual({ id: 500, note: 'Решено' })
    expect(await db.select().from(convOwed)).toHaveLength(0)
  })

  it('FR-CONV-12: a closed conversation, a test chat and a chat in shadow get nothing', async () => {
    await clientWrote('m-1', 40)
    await updateConversation(db, convId, { closedAt: at.toISOString() })
    expect((await owedPass(deps, at)).reminded).toBe(0)
    await updateConversation(db, convId, { closedAt: null })
    await setSetting(db, 'conv.v1_writes', true, 'system')
    expect((await owedPass(deps, at)).reminded).toBe(0)
    await setSetting(db, 'conv.v1_writes', false, 'system')
    await db
      .update(chatMessage)
      .set({ sentAt: new Date(at.getTime() - 30 * 24 * 60 * MIN).toISOString() })
      .where(eq(chatMessage.conversationId, convId))
    expect((await owedPass(deps, at)).reminded).toBe(0)
  })

  it('FR-NOTIF-3: one summary a day in the general topic, with the old ones in it', async () => {
    await clientWrote('m-1', 3 * 24 * 60)
    await owedPass(deps, at)
    const summary = texts.find((t) => t.place === 'general')
    expect(summary?.text).toContain('Ждут твоего ответа: 1')
    expect(summary?.text).toContain(
      '<a href="https://t.me/c/1/2">Татьяна</a>, заказ «Маркетинг»: ждёт 3 дня',
    )
    // Only once that day, and a rung 3 days past is not sent twice.
    await owedPass(deps, new Date(at.getTime() + 2 * MIN))
    expect(texts.filter((t) => t.place === 'general')).toHaveLength(1)
    expect(texts.filter((t) => t.place !== 'general')).toHaveLength(1)
  })
})
