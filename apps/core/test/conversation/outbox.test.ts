import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deliverMessage, queueMessage, sendTurnReply } from '../../src/conversation/outbox'
import { ensureConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import { conversation, convTurn, outbox, task } from '../../src/db/schema'
import { type ProfiClient, ProfiError } from '../../src/profi/client'
import { setSetting } from '../../src/settings/store'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)
const CHAT = '95147898'
let convId: string
let profi: ReturnType<typeof stubProfi>
let sendCalls: Parameters<ProfiClient['sendMessage']>[0][]
let behaviour: 'ok' | 'lost' | 'changed' | 'fail'

beforeEach(async () => {
  await resetDb(db)
  sendCalls = []
  behaviour = 'ok'
  profi = stubProfi([
    chatMsg('m-1', 'specialist', 'Отклик', new Date(Date.now() - 3600_000).toISOString()),
    chatMsg('m-2', 'client', 'Как начнём?', new Date().toISOString()),
  ])
  profi.sendMessage = async (i) => {
    sendCalls.push(i)
    if (behaviour === 'changed') throw new ProfiError('CHAT_CHANGED', 'chat moved on')
    if (behaviour === 'fail') throw new ProfiError('SESSION_DEAD', 'logged out')
    // The node keeps one message per key: a repeat never adds a second one.
    if (!profi.chat.some((m) => m.platform_message_id === `sent-${i.idempotency_key}`))
      profi.chat.push(
        chatMsg(`sent-${i.idempotency_key}`, 'specialist', i.text, new Date().toISOString()),
      )
    if (behaviour === 'lost') {
      behaviour = 'ok'
      throw new ProfiError('UNCERTAIN', 'connection reset')
    }
    return { found_on_page: true, platform_message_id: `sent-${i.idempotency_key}` }
  }
  const conv = await ensureConversation(db, {
    accountId: 'hance-marketing',
    chatId: CHAT,
    orderId: CHAT,
  })
  convId = conv.id
  await syncChat({ db, profi }, conv, new Date(), { v1Writes: false })
  await db.insert(convTurn).values({
    id: 't-1',
    conversationId: convId,
    anchorMessageId: 'm-2',
    messageIds: ['m-2'],
    text: 'Начнём с короткого созвона.',
    decision: 'send',
  })
  await setSetting(db, 'conv.v1_writes', false, 'system')
  await setSetting(db, 'conv.autopilot', true, 'system')
  await setSetting(db, 'outbound.messages', true, 'system')
  // The reset, the sync and the settings are a dozen queries on a database other test processes may hold locks on:
  // a loaded machine took over 10 s once (not seen alone, 0.4-1.9 s), so the hook gets an honest 30 s.
}, 30_000)

describe('sending to a client', () => {
  it('FR-CONV-9: a reply goes with its key and the last message the turn saw', async () => {
    expect(await sendTurnReply({ db, profi }, 't-1', 1)).toBe('confirmed')
    expect(sendCalls[0]).toMatchObject({
      chat_id: CHAT,
      text: 'Начнём с короткого созвона.',
      expect_last_message_id: 'm-2',
      idempotency_key: 'msg:t-1:1',
    })
    const [row] = await db.select().from(outbox)
    expect(row).toMatchObject({ kind: 'message', state: 'confirmed' })
    expect(await countEvents(db, 'conv.turn_sent')).toBe(0)
    expect(await countEvents(db, 'outbox.confirmed')).toBe(1)
  })

  it('FR-CONV-9: the service is told the last message the turn’s own reread saw, not the newest the core has', async () => {
    // A message the core stored after the reread (another sync) must make the service refuse, not pass.
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: CHAT,
      orderId: CHAT,
    })
    profi.chat.push(chatMsg('m-3', 'client', 'И ещё вопрос', new Date().toISOString()))
    await syncChat({ db, profi }, conv, new Date(), { v1Writes: false })
    expect(await sendTurnReply({ db, profi }, 't-1', 1, 'm-2')).toBe('confirmed')
    expect(sendCalls[0]?.expect_last_message_id).toBe('m-2')
  })

  it('FR-CONV-9: a lost answer after sending gives no second message', async () => {
    behaviour = 'lost'
    expect(await sendTurnReply({ db, profi }, 't-1', 1)).toBe('confirmed')
    expect(
      profi.chat.filter((m) => m.author === 'specialist' && m.text.startsWith('Начнём')),
    ).toHaveLength(1)
  })

  it('FR-CONV-6: the service refusing with CHAT_CHANGED sends nothing and the turn plans again', async () => {
    behaviour = 'changed'
    expect(await sendTurnReply({ db, profi }, 't-1', 1)).toBe('changed')
    const [row] = await db.select().from(outbox)
    expect(row?.state).toBe('changed')
  })

  it('FR-CONV-5: queueMessage refuses in shadow even for Boris’s text', async () => {
    await setSetting(db, 'conv.v1_writes', true, 'system')
    const id = await db.transaction((tx) =>
      queueMessage(tx, {
        key: 'k-1',
        accountId: 'hance-marketing',
        chatId: CHAT,
        text: 'x',
        author: 'boris',
        expectLast: null,
      }),
    )
    expect(id).toBeNull()
    expect(await db.select().from(outbox)).toHaveLength(0)
  })

  it('FR-CONV-5: queueMessage refuses Sara’s own text while outbound.messages is off, Boris’s text passes', async () => {
    await setSetting(db, 'outbound.messages', false, 'system')
    const q = (author: 'sara' | 'boris', key: string) =>
      db.transaction((tx) =>
        queueMessage(tx, {
          key,
          accountId: 'hance-marketing',
          chatId: CHAT,
          text: 'x',
          author,
          expectLast: null,
        }),
      )
    expect(await q('sara', 'k-1')).toBeNull()
    expect(await q('boris', 'k-2')).not.toBeNull()
  })

  describe('with the autopilot off', () => {
    // The text of the card's turn (t-1): what Boris's press sends.
    const q = (
      author: 'sara' | 'boris',
      key: string,
      text = 'Начнём с короткого созвона.',
      chatId = CHAT,
    ) =>
      db.transaction((tx) =>
        queueMessage(tx, {
          key,
          accountId: 'hance-marketing',
          chatId,
          text,
          author,
          expectLast: 'm-2',
        }),
      )
    /** The card Boris pressed «Отправить» on: its task is resolved with «send» before the text is queued. */
    const pressed = async (resolution: string | null = 'send') => {
      const id = newEventId()
      await db.insert(task).values({
        id,
        kind: 'conv_draft',
        entityKind: 'conv_turn',
        entityId: 't-1',
        state: resolution ? 'resolved' : 'open',
        resolution,
      })
      return id
    }

    beforeEach(async () => {
      await setSetting(db, 'conv.autopilot', false, 'system')
    })

    it('FR-CONV-5: a message of Sara’s own without Boris’s press is refused, nothing is queued or sent', async () => {
      expect(await q('sara', 'conv-remind:c-1:m-1:1')).toBeNull()
      expect(await sendTurnReply({ db, profi }, 't-1', 1)).toBe('failed')
      expect(await db.select().from(outbox)).toHaveLength(0)
      expect(sendCalls).toHaveLength(0)
      expect(await countEvents(db, 'outbox.queued')).toBe(0)
    })

    it('FR-CONV-5: a key that only looks like a press is refused: no task of Boris’s press stands behind it', async () => {
      expect(await q('sara', 'send:forged')).toBeNull()
      expect(await q('sara', `send:${newEventId()}`)).toBeNull()
      // A card that is still open, or one he answered otherwise, is no press on «Отправить» either.
      const open = await pressed(null)
      const skipped = await pressed('skip')
      expect(await q('sara', `send:${open}`)).toBeNull()
      expect(await q('sara', `send:${skipped}`)).toBeNull()
      expect(await q('sara', 'say:tg:5')).toBeNull()
      expect(await db.select().from(outbox)).toHaveLength(0)
    })

    it('FR-CONV-5: a press key is bound to its card: its text, its conversation and its kind', async () => {
      const card = await pressed()
      // Another text than the card's: the press said yes to a text Boris never saw.
      expect(await q('sara', `send:${card}`, 'Совсем другой текст')).toBeNull()
      // Another chat than the card's conversation.
      expect(await q('sara', `send:${card}`, undefined, 'other-chat')).toBeNull()
      // A task of another kind, answered with «send» by some other press.
      const other = newEventId()
      await db.insert(task).values({
        id: other,
        kind: 'lead_review',
        entityKind: 'lead',
        entityId: 'x',
        state: 'resolved',
        resolution: 'send',
      })
      expect(await q('sara', `send:${other}`)).toBeNull()
      // A card whose turn is in another conversation, with the same text.
      const [conv] = await db.select().from(conversation)
      const [second] = await db
        .insert(conversation)
        .values({ id: newEventId(), accountId: 'hance-marketing', chatId: 'other-chat' })
        .returning()
      await db.insert(convTurn).values({
        id: 't-other',
        conversationId: second?.id ?? '',
        anchorMessageId: 'm-9',
        text: 'Начнём с короткого созвона.',
      })
      const foreign = newEventId()
      await db.insert(task).values({
        id: foreign,
        kind: 'conv_draft',
        entityKind: 'conv_turn',
        entityId: 't-other',
        state: 'resolved',
        resolution: 'send',
      })
      expect(await q('sara', `send:${foreign}`)).toBeNull()
      expect(conv?.chatId).toBe(CHAT)
      expect(await db.select().from(outbox)).toHaveLength(0)
      // The right text, chat and card: it goes.
      expect(await q('sara', `send:${card}`)).not.toBeNull()
    })

    it('FR-CONV-12: the card of a reminder is bound the same way, to the text of its row', async () => {
      const [conv] = await db.select().from(conversation)
      await db.insert(convTurn).values({
        id: 'conv-remind:x:m-1:1',
        conversationId: conv?.id ?? '',
        kind: 'reminder',
        anchorMessageId: 'm-1',
        text: 'Анна, здравствуйте! Как у вас дела?',
      })
      const card = newEventId()
      await db.insert(task).values({
        id: card,
        kind: 'conv_draft',
        entityKind: 'conv_turn',
        entityId: 'conv-remind:x:m-1:1',
        state: 'resolved',
        resolution: 'send',
      })
      expect(await q('sara', `send:${card}`, 'Начнём с короткого созвона.')).toBeNull()
      expect(await q('sara', `send:${card}`, 'Анна, здравствуйте! Как у вас дела?')).not.toBeNull()
    })

    it('FR-CONV-5: Boris’s press on «Отправить» still sends, once', async () => {
      const card = await pressed()
      const id = await q('sara', `send:${card}`)
      expect(id).not.toBeNull()
      expect(await q('sara', `send:${card}`)).toBe(id)
      expect(await deliverMessage({ db, profi }, id ?? '')).toBe('confirmed')
      expect(sendCalls.map((c) => c.idempotency_key)).toEqual([`msg:send:${card}`])
      expect(await db.select().from(outbox)).toHaveLength(1)
    })

    it('FR-CONV-5: Boris’s own text is his press and passes, with any key', async () => {
      expect(await q('boris', 'say:tg:77')).not.toBeNull()
      expect(await q('boris', 'say:abc')).not.toBeNull()
    })

    it('NFR-UX-1: Boris’s own text goes marked as his, so its quotes stay; Sara’s goes unmarked (11.11.2026)', async () => {
      const own = await q('boris', 'say:tg:79', 'Скажу «спасибо» сам')
      await setSetting(db, 'conv.autopilot', true, 'system')
      const hers = await q('sara', 'conv-remind:c-1:m-1:2', 'Начнём с короткого созвона.')
      expect(await deliverMessage({ db, profi }, own ?? '')).toBe('confirmed')
      expect(await deliverMessage({ db, profi }, hers ?? '')).toBe('confirmed')
      expect(sendCalls.map((c) => c.asWritten === true)).toEqual([true, false])
    })

    it('FR-CONV-5: the shadow and the «Пишет клиентам» pause still hold a press', async () => {
      const card = await pressed()
      await setSetting(db, 'outbound.messages', false, 'system')
      expect(await q('sara', `send:${card}`)).toBeNull()
      await setSetting(db, 'outbound.messages', true, 'system')
      await setSetting(db, 'conv.v1_writes', true, 'system')
      expect(await q('sara', `send:${card}`)).toBeNull()
      expect(await q('boris', 'say:tg:78')).toBeNull()
    })

    it('FR-CONV-5: with the autopilot on Sara’s own message goes with any key', async () => {
      await setSetting(db, 'conv.autopilot', true, 'system')
      expect(await q('sara', 'conv-remind:c-1:m-1:1')).not.toBeNull()
    })
  })

  it('NFR-REL-4: a failed delivery is not retried blindly', async () => {
    behaviour = 'fail'
    const id = await db.transaction((tx) =>
      queueMessage(tx, {
        key: 'k-3',
        accountId: 'hance-marketing',
        chatId: CHAT,
        text: 'x',
        author: 'sara',
        expectLast: 'm-2',
      }),
    )
    expect(await deliverMessage({ db, profi }, id ?? '')).toBe('failed')
    expect(sendCalls).toHaveLength(1)
    const [row] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.id, id ?? ''))
    expect(row?.errorClass).toBe('SESSION_DEAD')
  })

  it('FR-CONV-9: the same turn and round never queue twice', async () => {
    await sendTurnReply({ db, profi }, 't-1', 1)
    await sendTurnReply({ db, profi }, 't-1', 1)
    expect(await db.select().from(outbox)).toHaveLength(1)
    expect(sendCalls).toHaveLength(1)
  })
})
