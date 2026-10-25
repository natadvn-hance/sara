import { DBOS } from '@dbos-inc/dbos-sdk'
import { type EventEnvelope, newEventId } from '@sara/shared'
import { asc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversationEvents } from '../../src/conversation/events'
import { remindWorkflowId, setRemindDeps, syncReminders } from '../../src/conversation/reminders'
import { getConversation } from '../../src/conversation/store'
import { storedOf } from '../../src/conversation/sync'
import type { ConversationRow } from '../../src/conversation/types'
import { chatMessage, conversation, deal, outbox, task } from '../../src/db/schema'
import { setSetting } from '../../src/settings/store'
import { launchDbos, shutdownDbos } from '../../src/workflows/dbos'
import { chatMsg, fakeMind, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb, testDatabaseUrl } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'
import { ACC, addMessages, type SeedMessage, seedChat } from '../helpers/reminders'

vi.setConfig({ testTimeout: 30_000 })

const { db, close } = openTestDb()
const CHAT = '95147898'
const HOUR = 3600_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const profi = stubProfi([])

const ours = (id: string, ms: number, text = 'Анна, добрый день! Сделаем сайт.'): SeedMessage => ({
  id,
  side: 'specialist',
  text,
  at: ago(ms),
})
const client = (id: string, ms: number): SeedMessage => ({
  id,
  side: 'client',
  text: 'Спасибо, посмотрю',
  at: ago(ms),
})

const statusOf = async (id: string) => (await DBOS.getWorkflowStatus(id))?.status ?? null
const stored = async (id: string) =>
  (
    await db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.conversationId, id))
      .orderBy(asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))
  ).map(storedOf)
const fresh = async (conv: ConversationRow) => {
  const c = await getConversation(db, conv.id)
  if (!c) throw new Error('no conversation')
  return c
}
const sync = async (conv: ConversationRow) =>
  syncReminders(await fresh(conv), await stored(conv.id))
const wf = (conv: ConversationRow, anchor: string) => remindWorkflowId(conv.id, anchor)

async function cancelAll() {
  const open = await DBOS.listWorkflows({
    workflowName: 'convRemind',
    status: ['PENDING', 'ENQUEUED', 'DELAYED'],
  })
  if (open.length) await DBOS.cancelWorkflows(open.map((w) => w.workflowID))
}

beforeAll(async () => {
  await launchDbos(testDatabaseUrl())
}, 60000)

afterAll(async () => {
  await cancelAll()
  await shutdownDbos()
  await close()
})

beforeEach(async () => {
  await resetDb(db)
  setRemindDeps({
    db,
    profi,
    gateway: (await fakeGateway(db, {})).gateway,
    mind: fakeMind(),
    notifier: { sendButtons: async () => ({ messageId: 1 }) },
  })
  await setSetting(db, 'pipeline.conversations', true, 'system')
})

afterEach(cancelAll)

describe('what the chat as read says about reminders', () => {
  it('FR-CONV-12: our message last starts the process of it, once however often the chat is read', async () => {
    const conv = await seedChat(db, CHAT, [ours('m-1', 2 * HOUR)])
    await sync(conv)
    await sync(conv)
    expect(await statusOf(wf(conv, 'm-1'))).toBe('PENDING')
    const all = await DBOS.listWorkflows({ workflow_id_prefix: `conv-remind:${conv.id}:` })
    expect(all).toHaveLength(1)
  })

  it('FR-CONV-12: a client message cancels the process that waits for the old last message', async () => {
    const conv = await seedChat(db, CHAT, [ours('m-1', 2 * HOUR)])
    await sync(conv)
    await addMessages(db, conv.id, CHAT, [client('m-2', 1000)])
    await sync(conv)
    expect(await statusOf(wf(conv, 'm-1'))).toBe('CANCELLED')
  })

  it('FR-CONV-12: a new message of our side cancels the old process and starts the one of the new', async () => {
    const conv = await seedChat(db, CHAT, [ours('m-1', 3 * HOUR)])
    await sync(conv)
    await addMessages(db, conv.id, CHAT, [ours('m-2', HOUR, 'Анна, я на связи')])
    await sync(conv)
    expect(await statusOf(wf(conv, 'm-1'))).toBe('CANCELLED')
    expect(await statusOf(wf(conv, 'm-2'))).toBe('PENDING')
  })

  it('FR-CONV-12: the reminder of the ladder itself is not a new beginning', async () => {
    const conv = await seedChat(db, CHAT, [ours('m-1', 30 * HOUR)])
    await sync(conv)
    const text = 'Анна, здравствуйте! Как у вас дела с сайтом?'
    await db.insert(outbox).values({
      id: newEventId(),
      kind: 'message',
      idempotencyKey: `msg:conv-remind:${conv.id}:m-1:1`,
      payload: { accountId: ACC, chatId: CHAT, text, author: 'sara', expectLast: 'm-1' },
      state: 'confirmed',
    })
    await addMessages(db, conv.id, CHAT, [
      { id: 's-1', side: 'specialist', text, at: ago(HOUR), author: 'sara', basis: 'outbox' },
    ])
    await sync(conv)
    expect(await statusOf(wf(conv, 'm-1'))).toBe('PENDING')
    expect(await statusOf(wf(conv, 's-1'))).toBeNull()
  })

  it('FR-CONV-12: a closed conversation, or a client of Boris, starts nothing and loses what waits', async () => {
    const conv = await seedChat(db, CHAT, [ours('m-1', 2 * HOUR)])
    await sync(conv)
    expect(await statusOf(wf(conv, 'm-1'))).toBe('PENDING')
    await db
      .update(conversation)
      .set({ owner: 'boris', ownerReason: 'take' })
      .where(eq(conversation.id, conv.id))
    await sync(conv)
    expect(await statusOf(wf(conv, 'm-1'))).toBe('CANCELLED')
    await db
      .update(conversation)
      .set({ owner: 'sara', ownerReason: null, closedAt: new Date().toISOString() })
      .where(eq(conversation.id, conv.id))
    await addMessages(db, conv.id, CHAT, [ours('m-2', HOUR, 'Анна, я на связи')])
    await sync(conv)
    expect(await statusOf(wf(conv, 'm-2'))).toBeNull()
  })

  it('FR-CONV-12: while conversations are off nothing starts', async () => {
    await setSetting(db, 'pipeline.conversations', false, 'system')
    const conv = await seedChat(db, CHAT, [ours('m-1', 2 * HOUR)])
    await sync(conv)
    expect(await statusOf(wf(conv, 'm-1'))).toBeNull()
  })

  it('FR-CONV-2: a message of an unclear author last stops the reminders', async () => {
    const conv = await seedChat(db, CHAT, [ours('m-1', 2 * HOUR)])
    await sync(conv)
    await addMessages(db, conv.id, CHAT, [
      { id: 'm-2', side: 'unknown', text: '???', at: ago(1000) },
    ])
    await sync(conv)
    expect(await statusOf(wf(conv, 'm-1'))).toBe('CANCELLED')
  })

  it('FR-CONV-12: a system message after ours does not hide our message', async () => {
    const conv = await seedChat(db, CHAT, [
      ours('m-1', 2 * HOUR),
      { id: 'm-2', side: 'system', text: 'Заказ выбран', at: ago(1000) },
    ])
    await sync(conv)
    expect(await statusOf(wf(conv, 'm-1'))).toBe('PENDING')
  })

  it('FR-CONV-12: the client writing again closes the task of Boris and wakes a dormant deal', async () => {
    const conv = await seedChat(db, CHAT, [ours('m-1', 8 * 24 * HOUR)], { deal: true })
    const dealRow = (await db.select().from(deal))[0]
    await db
      .update(deal)
      .set({ stage: 'dormant' })
      .where(eq(deal.id, dealRow?.id ?? ''))
    await db.insert(task).values({
      id: newEventId(),
      kind: 'conv_dormant',
      entityKind: 'conv_turn',
      entityId: `conv-remind:${conv.id}:m-1:dormant`,
      telegramMessageId: 7,
    })
    await addMessages(db, conv.id, CHAT, [client('m-2', 1000)])
    await sync(conv)
    expect((await db.select().from(task))[0]).toMatchObject({
      state: 'resolved',
      resolution: 'answered',
    })
    expect((await db.select().from(deal))[0]?.stage).toBe('talking')
  })

  it('FR-CONV-12: a new beginning closes the old dormant task, but not the one of the process that goes on', async () => {
    const conv = await seedChat(db, CHAT, [ours('m-1', 3 * HOUR)])
    await sync(conv)
    for (const anchor of ['m-1', 'm-2'])
      await db.insert(task).values({
        id: newEventId(),
        kind: 'conv_dormant',
        entityKind: 'conv_turn',
        entityId: `conv-remind:${conv.id}:${anchor}:dormant`,
        telegramMessageId: 7,
      })
    await addMessages(db, conv.id, CHAT, [ours('m-2', HOUR, 'Анна, я на связи')])
    await sync(conv)
    const tasks = await db.select().from(task)
    expect(tasks.find((t) => t.entityId.includes(':m-1:'))?.state).toBe('resolved')
    expect(tasks.find((t) => t.entityId.includes(':m-2:'))?.state).toBe('open')
  })
})

describe('the events of a chat and the reminders', () => {
  const envelope = (type: EventEnvelope['type'], id: string, author: string): EventEnvelope => ({
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
    payload: {
      chat_id: CHAT,
      order_id: CHAT,
      platform_message_id: id,
      sent_at: new Date().toISOString(),
      author,
    },
  })
  const events = () =>
    createConversationEvents({
      db,
      profi,
      notifier: { sendText: async () => ({ messageId: 1 }) },
      onTurnNeeded: async () => {},
      onTyping: async () => {},
      onSpecialist: async () => {},
      onChatState: (c, messages) => syncReminders(c, messages),
    })

  it('FR-CONV-12: our message in the chat starts the process, the client answering cancels it', async () => {
    profi.chat.splice(
      0,
      profi.chat.length,
      chatMsg('m-1', 'specialist', 'Анна, добрый день!', ago(HOUR), CHAT),
    )
    const onEvent = events()
    await onEvent(envelope('profi.specialist_message', 'm-1', 'specialist'))
    const conv = (await db.select().from(conversation))[0]
    expect(await statusOf(wf(conv as unknown as ConversationRow, 'm-1'))).toBe('PENDING')
    profi.chat.push(chatMsg('m-2', 'client', 'Добрый день', ago(1000), CHAT))
    await onEvent(envelope('profi.client_message', 'm-2', 'client'))
    await sleep(200)
    expect(await statusOf(wf(conv as unknown as ConversationRow, 'm-1'))).toBe('CANCELLED')
  })

  it('FR-CONV-12: a reminder machinery that fails does not break the reading of the chat', async () => {
    profi.chat.splice(
      0,
      profi.chat.length,
      chatMsg('m-1', 'specialist', 'Анна, добрый день!', ago(HOUR), CHAT),
    )
    const onEvent = createConversationEvents({
      db,
      profi,
      notifier: { sendText: async () => ({ messageId: 1 }) },
      onTurnNeeded: async () => {},
      onTyping: async () => {},
      onSpecialist: async () => {},
      onChatState: async () => {
        throw new Error('reminders are broken')
      },
    })
    await onEvent(envelope('profi.specialist_message', 'm-1', 'specialist'))
    expect(await db.select().from(chatMessage)).toHaveLength(1)
  })
})
