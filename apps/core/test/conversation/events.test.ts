import { type EventEnvelope, newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createConversationEvents } from '../../src/conversation/events'
import { reconcileChats } from '../../src/conversation/reconcile'
import type { ConversationRow } from '../../src/conversation/types'
import { chatMessage, conversation } from '../../src/db/schema'
import { setSetting } from '../../src/settings/store'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
const CHAT = '95147898'
let texts: string[]
let turns: string[]
let typing: string[]
let specialist: number

beforeEach(async () => {
  await resetDb(db)
  texts = []
  turns = []
  typing = []
  specialist = 0
})

function envelope(type: EventEnvelope['type'], payload: Record<string, unknown>): EventEnvelope {
  return {
    id: newEventId(),
    type,
    v: 1,
    entity: { kind: 'chat', id: CHAT },
    account_id: ACC,
    actor: 'profi',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload,
  }
}

const ref = (id: string, author = 'client') => ({
  chat_id: CHAT,
  order_id: CHAT,
  platform_message_id: id,
  sent_at: new Date().toISOString(),
  author,
})

function setup(chat = stubProfi([])) {
  const onEvent = createConversationEvents({
    db,
    profi: chat,
    notifier: { sendText: async (t) => (texts.push(t), { messageId: texts.length }) },
    onTurnNeeded: async (c: ConversationRow) => {
      turns.push(c.chatId)
    },
    onTyping: async (c: ConversationRow) => {
      typing.push(c.chatId)
    },
    onSpecialist: async () => {
      specialist++
    },
  })
  return { onEvent, chat }
}

describe('conversation events', () => {
  it('FR-CONV-1: a client message is stored and starts a turn when conversations are on', async () => {
    await setSetting(db, 'pipeline.conversations', true, 'system')
    const { onEvent, chat } = setup()
    chat.chat.push(chatMsg('m-1', 'specialist', 'Отклик', '2026-10-20T09:00:00.000Z'))
    chat.chat.push(chatMsg('m-2', 'client', 'Сколько стоит?', new Date().toISOString()))
    await onEvent(envelope('profi.client_message', ref('m-2')))
    expect(await db.select().from(chatMessage)).toHaveLength(2)
    expect(turns).toEqual([CHAT])
    const [c] = await db.select().from(conversation)
    expect(c?.lastClientHeardAt).not.toBeNull()
  })

  it('FR-CONV-1: each new client message reaches Boris at once, in the client topic, before any draft', async () => {
    await setSetting(db, 'pipeline.conversations', true, 'system')
    const places: unknown[] = []
    const chat = stubProfi([])
    chat.chat.push(chatMsg('m-1', 'client', 'Покажите примеры', new Date().toISOString()))
    const first = createConversationEvents({
      db,
      profi: chat,
      notifier: {
        sendText: async (t, o) => (
          texts.push(t), places.push(o?.place), { messageId: texts.length }
        ),
      },
      onTurnNeeded: async () => {},
      onTyping: async () => {},
      onSpecialist: async () => {},
    })
    await first(envelope('profi.client_message', ref('m-1')))
    chat.chat.push(chatMsg('m-2', 'client', 'И цены', new Date().toISOString()))
    await first(envelope('profi.client_message', ref('m-2')))
    // The same message heard twice is shown once.
    await first(envelope('profi.client_message', ref('m-2')))
    expect(texts).toEqual(['💬 Клиент: Покажите примеры', '💬 Клиент: И цены'])
    const [c] = await db.select().from(conversation)
    expect(places).toEqual([{ conversation: c?.id }, { conversation: c?.id }])
  })

  it('FR-CONV-1: with conversations off nothing is shown at once', async () => {
    const { onEvent, chat } = setup()
    chat.chat.push(chatMsg('m-2', 'client', 'Сколько стоит?', new Date().toISOString()))
    await onEvent(envelope('profi.client_message', ref('m-2')))
    expect(texts).toEqual([])
  })

  it('FR-CONV-1: with conversations off the message is stored and no turn starts', async () => {
    const { onEvent, chat } = setup()
    chat.chat.push(chatMsg('m-2', 'client', 'Сколько стоит?', new Date().toISOString()))
    await onEvent(envelope('profi.client_message', ref('m-2')))
    expect(await db.select().from(chatMessage)).toHaveLength(1)
    expect(turns).toEqual([])
  })

  it('FR-CONV-2: an unclear author stops the conversation and the third one tells Boris once', async () => {
    await setSetting(db, 'pipeline.conversations', true, 'system')
    const { onEvent } = setup()
    for (const id of ['u-1', 'u-2', 'u-3', 'u-4'])
      await onEvent(envelope('profi.author_unclear', ref(id, 'unknown')))
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatch(/не понимаю, кто написал/)
    expect(turns).toEqual([])
    expect(await countEvents(db, 'conv.author_unclear')).toBe(4)
  })

  it('FR-CONV-2: a clear client message resets the unclear count', async () => {
    await setSetting(db, 'pipeline.conversations', true, 'system')
    const { onEvent, chat } = setup()
    await onEvent(envelope('profi.author_unclear', ref('u-1', 'unknown')))
    await onEvent(envelope('profi.author_unclear', ref('u-2', 'unknown')))
    chat.chat.push(chatMsg('m-2', 'client', 'Привет', new Date().toISOString()))
    await onEvent(envelope('profi.client_message', ref('m-2')))
    const [c] = await db.select().from(conversation)
    expect(c?.unclearCount).toBe(0)
  })

  it('FR-CONV-7: typing is noted and pokes the turn', async () => {
    const { onEvent } = setup()
    await onEvent(envelope('profi.client_typing', { chat_id: CHAT, at: new Date().toISOString() }))
    const [c] = await db.select().from(conversation)
    expect(c?.typingAt).not.toBeNull()
    expect(typing).toEqual([CHAT])
  })

  it('FR-CONV-10: a specialist message goes to the comparison', async () => {
    const { onEvent, chat } = setup()
    chat.chat.push(chatMsg('m-3', 'specialist', 'Ответ', new Date().toISOString()))
    await onEvent(envelope('profi.specialist_message', ref('m-3', 'specialist')))
    expect(specialist).toBe(1)
  })

  it('FR-CONV-12: the client read our message', async () => {
    const { onEvent, chat } = setup()
    chat.chat.push({
      ...chatMsg('m-3', 'specialist', 'Ответ', new Date().toISOString()),
      read: false,
    })
    await onEvent(envelope('profi.specialist_message', ref('m-3', 'specialist')))
    await onEvent(
      envelope('profi.client_read', {
        chat_id: CHAT,
        platform_message_id: 'm-3',
        at: new Date().toISOString(),
      }),
    )
    const [m] = await db.select().from(chatMessage)
    expect(m?.read).toBe(true)
  })
})

describe('reconcile', () => {
  it('FR-CONV-1: the 10-minute check reads a chat whose last message is newer than ours', async () => {
    await setSetting(db, 'pipeline.conversations', true, 'system')
    const now = new Date()
    const p = stubProfi([chatMsg('m-9', 'client', 'Вы тут?', now.toISOString())])
    p.listChats = async () => ({
      chats: [
        { chat_id: CHAT, order_id: CHAT, last_message_at: now.toISOString(), unread: 1 },
        {
          chat_id: 'old',
          order_id: 'old',
          last_message_at: new Date(now.getTime() - 5 * 86400_000).toISOString(),
          unread: 0,
        },
      ],
    })
    const { onEvent } = setup(p)
    const n = await reconcileChats(
      {
        db,
        profi: p,
        notifier: { sendText: async () => ({ messageId: 1 }) },
        onTurnNeeded: async (c) => {
          turns.push(c.chatId)
        },
        onTyping: async () => {},
        onSpecialist: async () => {},
      },
      [ACC],
      now,
    )
    expect(n).toBe(1)
    expect(await db.select().from(chatMessage)).toHaveLength(1)
    expect(turns).toEqual([CHAT])
    expect(
      await reconcileChats(
        {
          db,
          profi: p,
          notifier: { sendText: async () => ({ messageId: 1 }) },
          onTurnNeeded: async () => {},
          onTyping: async () => {},
          onSpecialist: async () => {},
        },
        [ACC],
        now,
      ),
    ).toBe(0)
  })

  it('FR-CONV-1: one account failing does not stop the check of the others', async () => {
    await setSetting(db, 'pipeline.conversations', true, 'system')
    const now = new Date()
    const p = stubProfi([chatMsg('m-9', 'client', 'Вы тут?', now.toISOString())])
    p.listChats = async (accountId: string) => {
      if (accountId === 'broken') throw new Error('the account is not logged in')
      return {
        chats: [{ chat_id: CHAT, order_id: CHAT, last_message_at: now.toISOString(), unread: 1 }],
      }
    }
    const n = await reconcileChats(
      {
        db,
        profi: p,
        notifier: { sendText: async () => ({ messageId: 1 }) },
        onTurnNeeded: async (c) => {
          turns.push(c.chatId)
        },
        onTyping: async () => {},
        onSpecialist: async () => {},
      },
      ['broken', ACC],
      now,
    )
    expect(n).toBe(1)
    expect(turns).toEqual([CHAT])
  })
})
