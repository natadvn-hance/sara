import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sendTurnCard } from '../../src/conversation/cards'
import {
  close,
  giveBack,
  onConvEdit,
  onConvPress,
  onConvReply,
  parseCardReply,
  say,
  take,
} from '../../src/conversation/commands'
import { sendTextNow } from '../../src/conversation/outbox'
import { ensureConversation, getConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import {
  chatMessage,
  conversation,
  convTurn,
  deal,
  lead,
  mindProposal,
  outbox,
  question,
  task,
} from '../../src/db/schema'
import { handleBorisMessage } from '../../src/learning/inbox'
import { ProfiError } from '../../src/profi/client'
import { setSetting } from '../../src/settings/store'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close: closeDb } = openTestDb()
afterAll(closeDb)

const CHAT = '95147898'
let texts: string[]
let convId: string
let cardTask: string
let cardMessage: number
const notifier = {
  sendText: async (t: string) => {
    texts.push(t)
    return { messageId: 500 + texts.length }
  },
  sendButtons: async (t: string) => {
    texts.push(t)
    return { messageId: 200 + texts.length }
  },
  editText: async () => {},
}
const deps = () => ({ db, notifier })

beforeEach(async () => {
  await resetDb(db)
  texts = []
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
  await db
    .insert(deal)
    .values({ id: newEventId(), leadId: CHAT, accountId: 'hance-marketing', stage: 'talking' })
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
        chatMsg('m-1', 'specialist', 'Отклик', new Date(Date.now() - 3600_000).toISOString()),
        chatMsg('m-2', 'client', 'Как начнём?', new Date().toISOString()),
      ]),
    },
    conv,
    new Date(),
    { v1Writes: true },
  )
  await db.insert(convTurn).values({
    id: 't-1',
    conversationId: convId,
    anchorMessageId: 'm-2',
    messageIds: ['m-2'],
    state: 'finished',
    outcome: 'drafted',
    move: 'reply',
    text: 'Начнём с короткого созвона.',
    factIds: ['k-process-start'],
    decision: 'draft',
    decisionReason: 'режим тени',
  })
  const r = await sendTurnCard(deps(), 't-1')
  cardTask = r?.taskId ?? ''
  cardMessage = r?.messageId ?? 0
  texts = []
})

describe('Boris’s commands', () => {
  it('FR-CONV-11: «Беру сам» makes the client Boris’s and resolves the card', async () => {
    expect(await onConvPress(deps(), { taskId: cardTask, action: 'take' })).toMatch(/Клиент твой/)
    expect(await getConversation(db, convId)).toMatchObject({ owner: 'boris', ownerReason: 'take' })
    const [t] = await db.select().from(task).where(eq(task.id, cardTask))
    expect(t).toMatchObject({ state: 'resolved', resolution: 'take' })
    expect(await countEvents(db, 'conv.taken')).toBe(1)
    expect(await onConvPress(deps(), { taskId: cardTask, action: 'take' })).toMatch(/уже/)
  })

  it('FR-CONV-11: «Вернуть» with a note gives the client back and keeps the note', async () => {
    await take(db, convId, 'boris')
    expect(
      await onConvReply(deps(), {
        replyToMessageId: cardMessage,
        text: 'верни, она хочет созвон в пятницу',
        at: new Date(),
      }),
    ).toMatch(/Вернула/)
    const c = await getConversation(db, convId)
    expect(c).toMatchObject({ owner: 'sara', ownerReason: null })
    expect(c?.borisNote).toContain('она хочет созвон в пятницу')
    // As old Sara: nothing is answered now, the next client message is.
    expect(c?.handledThrough).toBe('m-2')
    expect(await countEvents(db, 'conv.returned')).toBe(1)
  })

  it('FR-CONV-11: «Закрыть» closes the conversation and loses the deal', async () => {
    expect(await onConvPress(deps(), { taskId: cardTask, action: 'close' })).toMatch(/закрыт/i)
    expect((await getConversation(db, convId))?.closedAt).not.toBeNull()
    const [d] = await db.select().from(deal)
    expect(d?.stage).toBe('lost')
    await giveBack(db, convId, null)
    expect((await getConversation(db, convId))?.closedAt).toBeNull()
  })

  it('FR-CONV-11: in shadow «написать текст» is kept as Boris’s answer and not sent', async () => {
    const answer = await say(deps(), convId, 'Анна, давайте созвонимся завтра в 11?')
    expect(answer).toMatch(/Режим тени/)
    const [t] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
    expect(t?.borisText).toBe('Анна, давайте созвонимся завтра в 11?')
    expect(await countEvents(db, 'conv.said')).toBe(1)
    expect(await db.select().from(mindProposal)).toHaveLength(1)
  })

  it('FR-CONV-11: «Изменить» asks for Boris’s version and his answer is kept beside the draft', async () => {
    expect(await onConvPress(deps(), { taskId: cardTask, action: 'edit' })).toMatch(/Жду/)
    const [q] = await db.select().from(question)
    expect(q?.kind).toBe('conv_edit')
    expect(
      await onConvEdit(deps(), {
        question: q as never,
        text: 'Мой вариант',
        voice: false,
        at: new Date(),
      }),
    ).toMatch(/Сохранила/)
    const [t] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
    expect(t?.borisText).toBe('Мой вариант')
    expect(await countEvents(db, 'conv.draft_edited')).toBe(1)
  })

  describe('Boris’s version after «Изменить»', () => {
    const inbox = () => ({
      db,
      transcriber: { transcribe: async () => null },
      onCardReply: (m: { replyToMessageId: number | null; text: string; at: Date }) =>
        onConvReply(deps(), m),
      onConvEdit: (a: Parameters<typeof onConvEdit>[1]) => onConvEdit(deps(), a),
    })
    const borisSays = (text: string, replyToMessageId: number | null) =>
      handleBorisMessage(inbox(), { text, voicePath: null, replyToMessageId, at: new Date() })

    it('FR-CONV-11: a message that is not a reply is never taken as his version of the reply', async () => {
      await onConvPress(deps(), { taskId: cardTask, action: 'edit' })
      const answer = await borisSays('Спасибо, посмотрю вечером', null)
      expect(answer).toMatch(/Пока я понимаю только ответы/)
      const [q] = await db.select().from(question)
      expect(q?.answeredAt).toBeNull()
      const [t] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
      expect(t?.borisText).toBeNull()
      expect(await db.select().from(mindProposal)).toHaveLength(0)
    })

    it('FR-CONV-11: a reply to the question is his version', async () => {
      await onConvPress(deps(), { taskId: cardTask, action: 'edit' })
      const [q] = await db.select().from(question)
      expect(await borisSays('Анна, давайте завтра в 11', q?.telegramMessageId ?? null)).toMatch(
        /Сохранила/,
      )
      const [t] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
      expect(t?.borisText).toBe('Анна, давайте завтра в 11')
    })

    it('FR-CONV-11: a reply to the card that is no command is his version while «Изменить» waits', async () => {
      await onConvPress(deps(), { taskId: cardTask, action: 'edit' })
      expect(await borisSays('Анна, давайте завтра в 11', cardMessage)).toMatch(/Сохранила/)
      const [t] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
      expect(t?.borisText).toBe('Анна, давайте завтра в 11')
      const [q] = await db.select().from(question)
      expect(q?.answeredAt).not.toBeNull()
      // Nothing waits any more: the next words on the card are not understood.
      expect(await borisSays('ещё что-то', cardMessage)).toMatch(/Не поняла/)
    })
  })

  it('ADR-016: Boris’s words proposed as an example keep no client name, also in a chat old Sara began', async () => {
    // A chat without a lead: the name is known from the greeting of our first message only.
    await db.update(conversation).set({ dealId: null })
    await db.delete(deal)
    await db.delete(lead)
    await syncChat(
      {
        db,
        profi: stubProfi([
          chatMsg(
            'm-0',
            'specialist',
            'Анна, добрый день! Понимаю задачу.',
            new Date(Date.now() - 7200_000).toISOString(),
          ),
        ]),
      },
      (await getConversation(db, convId)) as never,
      new Date(),
      { v1Writes: true },
    )
    await db.delete(mindProposal)
    await say(deps(), convId, 'Анна, начнём с короткого созвона.')
    const [p] = await db.select().from(mindProposal)
    expect(p?.content).not.toContain('Анна')
    expect(p?.content).toContain('[имя 1]')
  })

  it('ADR-016: no example is proposed from Boris’s words when no name of the client is known', async () => {
    await db.update(conversation).set({ dealId: null })
    await db.delete(deal)
    await db.delete(lead)
    await db.delete(chatMessage)
    await db.delete(mindProposal)
    await say(deps(), convId, 'Добрый день, начнём с короткого созвона.')
    expect(await db.select().from(mindProposal)).toHaveLength(0)
    // The words are still kept beside the draft.
    const [t] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
    expect(t?.borisText).toBe('Добрый день, начнём с короткого созвона.')
  })

  it('FR-CONV-11: «Хорошо» marks the draft good once', async () => {
    expect(await onConvPress(deps(), { taskId: cardTask, action: 'good' })).toMatch(/годн/)
    expect(await countEvents(db, 'conv.draft_good')).toBe(1)
    expect(await onConvPress(deps(), { taskId: cardTask, action: 'good' })).toMatch(/уже/)
  })

  it('FR-NOTIF-1: a command without a card is not guessed', async () => {
    expect(
      await onConvReply(deps(), { replyToMessageId: 999999, text: 'беру сам', at: new Date() }),
    ).toBeNull()
    expect(
      await onConvReply(deps(), { replyToMessageId: cardMessage, text: 'хм', at: new Date() }),
    ).toMatch(/Не поняла/)
  })

  it('FR-CONV-11: replies to a card are read as commands', () => {
    expect(parseCardReply('Беру сам')).toEqual({ cmd: 'take' })
    expect(parseCardReply('я сам')).toEqual({ cmd: 'take' })
    expect(parseCardReply('верни')).toEqual({ cmd: 'return', note: null })
    expect(parseCardReply('Вернуть Саре: веди мягко')).toEqual({
      cmd: 'return',
      note: 'веди мягко',
    })
    expect(parseCardReply('напиши: Анна, добрый день!')).toEqual({
      cmd: 'say',
      text: 'Анна, добрый день!',
    })
    expect(parseCardReply('отправь ей Давайте завтра')).toEqual({
      cmd: 'say',
      text: 'Давайте завтра',
    })
    expect(parseCardReply('закрой')).toEqual({ cmd: 'close' })
    expect(parseCardReply('да')).toEqual({ cmd: 'good' })
    expect(parseCardReply('что это')).toBeNull()
  })

  it('FR-CONV-11: after the switch «Отправить» is not the shadow answer', async () => {
    await setSetting(db, 'conv.v1_writes', false, 'system')
    const sent: string[] = []
    const answer = await onConvPress(
      {
        db,
        notifier,
        sendText: async (_c: string, text: string) => (sent.push(text), 'Отправила клиенту'),
      },
      { taskId: cardTask, action: 'send' },
    )
    expect(answer).toBe('Отправила клиенту')
    expect(sent).toEqual(['Начнём с короткого созвона.'])
  })

  describe('«Отправить» after the switch', () => {
    type SendOptions = { key?: string; expectLast?: string | null }
    let calls: { text: string; o: SendOptions | undefined }[]
    const press = () =>
      onConvPress(
        {
          db,
          notifier,
          sendText: async (_c: string, text: string, _a: 'sara' | 'boris', o?: SendOptions) => {
            calls.push({ text, o })
            return 'Отправила клиенту'
          },
        },
        { taskId: cardTask, action: 'send' },
      )
    beforeEach(async () => {
      calls = []
      await setSetting(db, 'conv.v1_writes', false, 'system')
      await setSetting(db, 'outbound.messages', true, 'system')
    })

    it.each(['queued', 'confirmed', 'uncertain'])(
      'FR-CONV-9: it is refused when the turn’s own reply is already %s in the outbox',
      async (state) => {
        await db.insert(outbox).values({
          id: newEventId(),
          kind: 'message',
          idempotencyKey: 'msg:t-1:1',
          payload: { chatId: CHAT, accountId: 'hance-marketing', text: 'Начнём', author: 'sara' },
          state,
        })
        expect(await press()).toMatch(/Ответ уже|не уверена/i)
        expect(calls).toEqual([])
        const [t] = await db.select().from(task).where(eq(task.id, cardTask))
        expect(t?.state).toBe('open')
      },
    )

    it('FR-CONV-9: a failed earlier try of the turn does not stop the press', async () => {
      await db.insert(outbox).values({
        id: newEventId(),
        kind: 'message',
        idempotencyKey: 'msg:t-1:1',
        payload: { chatId: CHAT, accountId: 'hance-marketing', text: 'Начнём', author: 'sara' },
        state: 'changed',
      })
      expect(await press()).toBe('Отправила клиенту')
    })

    it('FR-CONV-9: it is refused with «Ты уже ответил сам» when our side wrote after the client', async () => {
      await db.insert(chatMessage).values({
        id: newEventId(),
        accountId: 'hance-marketing',
        chatId: CHAT,
        orderId: CHAT,
        platformMessageId: 'm-3',
        side: 'specialist',
        author: 'boris',
        authorBasis: 'after_cutover',
        text: 'Анна, наберу вас',
        sentAt: new Date(Date.now() + 5000).toISOString(),
        source: 'node',
        conversationId: convId,
      })
      expect(await press()).toMatch(/Ты уже ответил сам/)
      expect(calls).toEqual([])
    })

    it('FR-CONV-9: the reply is sent once per card with the turn’s own last client message as the one to expect', async () => {
      expect(await press()).toBe('Отправила клиенту')
      expect(calls[0]?.o).toMatchObject({ expectLast: 'm-2', key: `send:${cardTask}` })
      const [t] = await db.select().from(task).where(eq(task.id, cardTask))
      expect(t).toMatchObject({ state: 'resolved', resolution: 'send' })
      expect(await press()).toMatch(/уже/)
      expect(calls).toHaveLength(1)
    })

    it('FR-CONV-9: a chat that moved on is refused by the service and Boris is told the draft is out of date', async () => {
      const conv = (await getConversation(db, convId)) as never
      const profi = stubProfi([
        chatMsg('m-1', 'specialist', 'Отклик', new Date(Date.now() - 3600_000).toISOString()),
        chatMsg('m-2', 'client', 'Как начнём?', new Date().toISOString()),
        chatMsg('m-3', 'client', 'И ещё вопрос', new Date(Date.now() + 1000).toISOString()),
      ])
      // The core has already stored the newer client message when Boris presses the button.
      await syncChat({ db, profi }, conv, new Date(), { v1Writes: false })
      profi.sendMessage = async (i) => {
        if (i.expect_last_message_id !== 'm-3') throw new ProfiError('CHAT_CHANGED', 'moved on')
        return { found_on_page: true, platform_message_id: 'x' }
      }
      const answer = await onConvPress(
        {
          db,
          notifier,
          sendText: (c, text, author, o) => sendTextNow({ db, profi }, c, text, author, o),
        },
        { taskId: cardTask, action: 'send' },
      )
      expect(answer).toMatch(/устарел/)
      const [row] = await db.select().from(outbox)
      expect(row?.state).toBe('changed')
    })
  })

  describe('Boris’s text after the switch is sent once', () => {
    let messageCalls: string[]
    const stack = () => {
      const profi = stubProfi([
        chatMsg('m-1', 'specialist', 'Отклик', new Date(Date.now() - 3600_000).toISOString()),
        chatMsg('m-2', 'client', 'Как начнём?', new Date().toISOString()),
      ])
      profi.sendMessage = async (i) => {
        messageCalls.push(i.idempotency_key)
        return { found_on_page: true, platform_message_id: `sent-${messageCalls.length}` }
      }
      return {
        db,
        transcriber: { transcribe: async () => null },
        onCardReply: (m: {
          replyToMessageId: number | null
          text: string
          voice: boolean
          at: Date
          messageId?: number
        }) =>
          onConvReply(
            {
              db,
              notifier,
              sendText: (c, text, author, o) => sendTextNow({ db, profi }, c, text, author, o),
            },
            m,
          ),
      }
    }
    beforeEach(async () => {
      messageCalls = []
      await setSetting(db, 'conv.v1_writes', false, 'system')
    })

    it('FR-CONV-9: the same Telegram message handled twice queues and sends one message', async () => {
      const inbox = stack()
      const m = {
        text: 'напиши: Анна, давайте в пятницу',
        voicePath: null,
        replyToMessageId: cardMessage,
        messageId: 4711,
        at: new Date(),
      }
      expect(await handleBorisMessage(inbox, m)).toBe('Отправила клиенту.')
      expect(await handleBorisMessage(inbox, m)).toBe('Отправила клиенту.')
      expect(await db.select().from(outbox)).toHaveLength(1)
      expect(messageCalls).toEqual(['msg:say:tg:4711'])
    })

    it('FR-CONV-9: two different Telegram messages are two messages', async () => {
      const inbox = stack()
      const base = { voicePath: null, replyToMessageId: cardMessage, at: new Date() }
      await handleBorisMessage(inbox, { ...base, text: 'напиши: Анна, в пятницу', messageId: 1 })
      await handleBorisMessage(inbox, { ...base, text: 'напиши: Анна, в субботу', messageId: 2 })
      expect(await db.select().from(outbox)).toHaveLength(2)
    })
  })
})
