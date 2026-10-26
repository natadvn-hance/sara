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
import { sendTextNow } from '../../src/conversation/sendJob'
import type { SendOptions } from '../../src/conversation/sendTexts'
import { ensureConversation, getConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import {
  account,
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

  it('FR-CONV-11: replies to a card are read as commands, whole messages only', () => {
    expect(parseCardReply('Беру сам')).toEqual({ cmd: 'take' })
    expect(parseCardReply('я сам')).toEqual({ cmd: 'take' })
    expect(parseCardReply('Беру.')).toEqual({ cmd: 'take' })
    expect(parseCardReply('Возьму её сам!')).toEqual({ cmd: 'take' })
    expect(parseCardReply('верни')).toEqual({ cmd: 'return', note: null })
    expect(parseCardReply('Вернуть Саре: веди мягко')).toEqual({
      cmd: 'return',
      note: 'веди мягко',
    })
    expect(parseCardReply('закрой')).toEqual({ cmd: 'close' })
    expect(parseCardReply('Закрыть разговор.')).toEqual({ cmd: 'close' })
    expect(parseCardReply('Закрываем!')).toEqual({ cmd: 'close' })
    expect(parseCardReply('что это')).toBeNull()
  })

  it('FR-CONV-11: his own text needs the colon, what follows it is exactly his words', () => {
    expect(parseCardReply('напиши: Анна, добрый день!')).toEqual({
      cmd: 'say',
      text: 'Анна, добрый день!',
    })
    expect(parseCardReply('Отправь ему: Давайте завтра\nв 11')).toEqual({
      cmd: 'say',
      text: 'Давайте завтра\nв 11',
    })
    expect(parseCardReply('ответь клиенту : Хорошо')).toEqual({ cmd: 'say', text: 'Хорошо' })
    // The command word with no text: Sara asks for it, nothing is cut out of a longer sentence.
    expect(parseCardReply('Отправь ему')).toEqual({ cmd: 'say', text: null })
    expect(parseCardReply('Напиши ей.')).toEqual({ cmd: 'say', text: null })
    expect(parseCardReply('напиши:')).toEqual({ cmd: 'say', text: null })
    expect(parseCardReply('напиши: ')).toEqual({ cmd: 'say', text: null })
    // No colon, a sentence: not a command, never «что я перезвоню завтра» or «Давайте завтра» as the text.
    expect(parseCardReply('Напиши ему, что я перезвоню завтра')).toBeNull()
    expect(parseCardReply('отправь ей Давайте завтра')).toBeNull()
    expect(parseCardReply('Отправь как есть')).toEqual({ cmd: 'confirm' })
  })

  it.each([
    'Закрыть не надо, подожди',
    'Закрой окно',
    'не закрывай',
    'Я сам не буду',
    'Беру сам, позвоню ей вечером',
    'Не беру',
    'Закрыть? Нет',
  ])('FR-CONV-11: «%s» is no command, nothing acts', async (words) => {
    expect(parseCardReply(words)).toBeNull()
    expect(
      await onConvReply(deps(), { replyToMessageId: cardMessage, text: words, at: new Date() }),
    ).toMatch(/Не поняла/)
    expect((await getConversation(db, convId))?.closedAt).toBeNull()
    expect((await getConversation(db, convId))?.owner).toBe('sara')
    expect((await db.select().from(task).where(eq(task.id, cardTask)))[0]?.state).toBe('open')
  })

  it('FR-CONV-11: after the switch «Отправить» is not the shadow answer', async () => {
    await setSetting(db, 'conv.v1_writes', false, 'system')
    await setSetting(db, 'outbound.messages', true, 'system')
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

    it('FR-CONV-9: the draft on a card that calls Boris goes with the key of the card, like any draft', async () => {
      await db
        .update(convTurn)
        .set({ decision: 'call_boris', move: 'call_boris', decisionReason: 'тема Бориса: price' })
        .where(eq(convTurn.id, 't-1'))
      expect(await press()).toBe('Отправила клиенту')
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        text: 'Начнём с короткого созвона.',
        o: { key: `send:${cardTask}`, expectLast: 'm-2' },
      })
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

  describe('Boris’s text after the switch is sent once, after his press', () => {
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
      const live = {
        db,
        notifier,
        sendText: (c: string, text: string, author: 'sara' | 'boris', o?: SendOptions) =>
          sendTextNow({ db, profi }, c, text, author, o),
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
        }) => onConvReply(live, m),
        press: (taskId: string) => onConvPress(live, { taskId, action: 'send' }),
      }
    }
    const confirmTask = (r: unknown) =>
      (r as { rows: { callbackData: string }[][] }).rows[0]?.[0]?.callbackData.split(':')[1] ?? ''
    beforeEach(async () => {
      messageCalls = []
      await setSetting(db, 'conv.v1_writes', false, 'system')
    })

    it('FR-CONV-9: the same Telegram message handled twice asks once, and its press sends one message', async () => {
      const inbox = stack()
      const m = {
        text: 'напиши: Анна, давайте в пятницу',
        voicePath: null,
        replyToMessageId: cardMessage,
        messageId: 4711,
        at: new Date(),
      }
      const first = await handleBorisMessage(inbox, m)
      expect(typeof (await handleBorisMessage(inbox, m))).toBe('string')
      expect(await db.select().from(outbox)).toHaveLength(0)
      expect(await inbox.press(confirmTask(first))).toBe('Отправила клиенту.')
      expect(await inbox.press(confirmTask(first))).toMatch(/уже/)
      expect(await db.select().from(outbox)).toHaveLength(1)
      expect(messageCalls).toEqual(['msg:say:tg:4711'])
    })

    it('FR-CONV-9: two different Telegram messages are two confirmations, and one answer to the card', async () => {
      const inbox = stack()
      const base = { voicePath: null, replyToMessageId: cardMessage, at: new Date() }
      const one = await handleBorisMessage(inbox, {
        ...base,
        text: 'напиши: Анна, в пятницу',
        messageId: 1,
      })
      const two = await handleBorisMessage(inbox, {
        ...base,
        text: 'напиши: Анна, в субботу',
        messageId: 2,
      })
      expect(confirmTask(one)).not.toBe(confirmTask(two))
      // Each press carries its own words; the card is answered once.
      expect(await inbox.press(confirmTask(two))).toBe('Отправила клиенту.')
      expect(await inbox.press(confirmTask(one))).toMatch(/уже/)
      expect(await db.select().from(outbox)).toHaveLength(1)
      expect((await db.select().from(outbox))[0]?.payload).toMatchObject({
        text: 'Анна, в субботу',
        author: 'boris',
      })
    })
  })

  describe('a typed reply never sends a draft (review: «Да нет, не отправляй» went)', () => {
    type Sent = {
      text: string
      author: 'sara' | 'boris'
      o?: { key?: string; expectLast?: string | null }
    }
    let sent: Sent[]
    const live = () => ({
      db,
      notifier,
      sendText: async (_c: string, text: string, author: 'sara' | 'boris', o?: Sent['o']) => {
        sent.push({ text, author, o })
        return 'Отправила клиенту.'
      },
    })
    const reply = (text: string, to: number | null = cardMessage) =>
      onConvReply(live(), { replyToMessageId: to, text, at: new Date() })
    const asText = (r: unknown) =>
      typeof r === 'string' ? r : ((r as { text: string })?.text ?? '')
    const asRows = (r: unknown) =>
      (r as { rows?: { text: string; callbackData: string }[][] } | null)?.rows?.flat() ?? []
    const openTask = async (id: string) => (await db.select().from(task).where(eq(task.id, id)))[0]

    beforeEach(async () => {
      sent = []
      await setSetting(db, 'conv.v1_writes', false, 'system')
      await setSetting(db, 'outbound.messages', true, 'system')
    })

    it.each([
      'Да нет, не отправляй, я сам позвоню',
      'Да, но убери цену',
      'Ок, только без скидки',
      'Хорошо, тогда созвонимся в среду в 15:00',
    ])('FR-CONV-11: «%s» in reply to a card sends nothing and is not a command', async (words) => {
      const r = await reply(words)
      expect(asText(r)).toMatch(/Не поняла/)
      expect(sent).toEqual([])
      expect((await openTask(cardTask))?.state).toBe('open')
    })

    it.each([
      'Да нет, не отправляй, я сам позвоню',
      'Да, но убери цену',
      'Ок, только без скидки',
      'Хорошо, тогда созвонимся в среду в 15:00',
    ])(
      'FR-CONV-11: «%s» with «Изменить» open is his version, sent only after he confirms it',
      async (words) => {
        await onConvPress(live(), { taskId: cardTask, action: 'edit' })
        const r = await reply(words)
        expect(sent).toEqual([])
        expect(asText(r)).toBe(`Отправлю клиенту так: «${words}»`)
        expect(asRows(r).map((b) => b.text)).toEqual(['Отправить', 'Изменить'])
        // The press on the confirmation sends his exact words, as his own, once.
        const confirm = asRows(r)[0]?.callbackData ?? ''
        const [, taskId, action] = confirm.split(':')
        expect(action).toBe('send')
        expect(await onConvPress(live(), { taskId: taskId ?? '', action: 'send' })).toBe(
          'Отправила клиенту.',
        )
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ text: words, author: 'boris' })
        expect(await onConvPress(live(), { taskId: taskId ?? '', action: 'send' })).toMatch(/уже/)
        expect(sent).toHaveLength(1)
      },
    )

    it.each([
      'да',
      'Да.',
      'ок',
      'Окей',
      'Отправляй',
      'отправь',
      'Как есть',
      // As a voice recognition writes them.
      'Да, отправляй.',
      'Ну да',
      'Окей, отправляй!',
    ])(
      'FR-CONV-11: «%s» does not send, it tells him to press «Отправить» on the same card',
      async (words) => {
        const r = await reply(words)
        expect(asText(r)).toBe('Нажми «Отправить», и уйдёт')
        expect(asRows(r)).toEqual([{ text: 'Отправить', callbackData: `t:${cardTask}:send` }])
        expect(sent).toEqual([])
        expect((await openTask(cardTask))?.state).toBe('open')
      },
    )

    it('FR-CONV-11: the button it attaches is the card’s own press, which sends the draft once', async () => {
      const r = await reply('да')
      const callback = asRows(r)[0]?.callbackData ?? ''
      const [, taskId, action] = callback.split(':')
      expect(await onConvPress(live(), { taskId: taskId ?? '', action: action as 'send' })).toBe(
        'Отправила клиенту.',
      )
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ text: 'Начнём с короткого созвона.', author: 'sara' })
      expect(sent[0]?.o?.key).toBe(`send:${cardTask}`)
    })

    it('FR-CONV-11: with «Изменить» open «да» is still no version of the reply and still sends nothing', async () => {
      await onConvPress(live(), { taskId: cardTask, action: 'edit' })
      const r = await reply('да')
      expect(asText(r)).toBe('Нажми «Отправить», и уйдёт')
      expect(sent).toEqual([])
      const [q] = await db.select().from(question)
      expect(q?.answeredAt).toBeNull()
    })

    it('FR-CONV-11: «напиши: …» shows his exact words and sends them only on «Отправить», closing the card', async () => {
      const words = 'Анна, давайте созвонимся завтра в 11?'
      const r = await reply(`напиши: ${words}`)
      expect(asText(r)).toBe(`Отправлю клиенту так: «${words}»`)
      expect(sent).toEqual([])
      const taskId = asRows(r)[0]?.callbackData.split(':')[1] ?? ''
      expect(await onConvPress(live(), { taskId, action: 'send' })).toBe('Отправила клиенту.')
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ text: words, author: 'boris' })
      // His text answered the card: the draft cannot go too.
      expect((await openTask(cardTask))?.state).toBe('resolved')
      expect(await onConvPress(live(), { taskId: cardTask, action: 'send' })).toMatch(/уже/)
      expect(sent).toHaveLength(1)
      const [t] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
      expect(t?.borisText).toBe(words)
    })

    it('FR-CONV-11: «Изменить» on the confirmation asks for a new version, which is confirmed again', async () => {
      const r = await reply('напиши: Анна, добрый день')
      const taskId = asRows(r)[0]?.callbackData.split(':')[1] ?? ''
      expect(await onConvPress(live(), { taskId, action: 'edit' })).toMatch(/Жду твой вариант/)
      expect((await openTask(taskId))?.state).toBe('resolved')
      expect(await onConvPress(live(), { taskId, action: 'send' })).toMatch(/уже/)
      expect(sent).toEqual([])
      const again = await reply('Анна, добрый вечер')
      expect(asText(again)).toBe('Отправлю клиенту так: «Анна, добрый вечер»')
      expect(sent).toEqual([])
    })

    it('FR-CONV-9: the same Telegram message handled twice asks once', async () => {
      const m = {
        replyToMessageId: cardMessage,
        text: 'напиши: Анна, в пятницу',
        messageId: 4711,
        at: new Date(),
      }
      const first = await onConvReply(live(), m)
      expect(asRows(first)).toHaveLength(2)
      const second = await onConvReply(live(), m)
      expect(asRows(second)).toHaveLength(0)
      expect(await db.select().from(task)).toHaveLength(2)
    })

    it('FR-CONV-11: «Отправь ему» with no text asks for the text and sends nothing', async () => {
      for (const words of ['Отправь ему', 'Напиши ей', 'напиши:']) {
        const r = await reply(words)
        expect(asText(r)).toMatch(/Что отправить клиенту/)
        expect(asRows(r)).toHaveLength(0)
      }
      expect(sent).toEqual([])
      expect(await db.select().from(task)).toHaveLength(1)
    })

    it('FR-CONV-11: a sentence that only starts like a command is not cut: no colon, no text', async () => {
      const said = 'Напиши ему, что я перезвоню завтра'
      expect(asText(await reply(said))).toMatch(/Не поняла/)
      // While «Изменить» waits it is his version, shown whole for his confirmation.
      await onConvPress(live(), { taskId: cardTask, action: 'edit' })
      const r = await reply(said)
      expect(asText(r)).toBe(`Отправлю клиенту так: «${said}»`)
      expect(sent).toEqual([])
    })

    it('FR-CONV-11: «Закрыть не надо, подожди» with «Изменить» open is his version, nothing is closed', async () => {
      await onConvPress(live(), { taskId: cardTask, action: 'edit' })
      const r = await reply('Закрыть не надо, подожди')
      expect(asText(r)).toBe('Отправлю клиенту так: «Закрыть не надо, подожди»')
      expect((await getConversation(db, convId))?.closedAt).toBeNull()
      expect(sent).toEqual([])
    })

    it('FR-CONV-11: in shadow nothing changes: «напиши: …» is kept, «да» points at «Хорошо»', async () => {
      await setSetting(db, 'conv.v1_writes', true, 'system')
      expect(asText(await reply('напиши: Анна, в пятницу'))).toMatch(/Режим тени/)
      const r = await reply('да')
      expect(asText(r)).toBe('Нажми «Хорошо», и отмечу, что черновик годный')
      expect(asRows(r)).toEqual([{ text: 'Хорошо', callbackData: `t:${cardTask}:good` }])
      expect(sent).toEqual([])
    })

    it('FR-CONV-11: «да» on a card that is already answered says so and offers no button', async () => {
      await onConvPress(live(), { taskId: cardTask, action: 'take' })
      const r = await reply('да')
      expect(asText(r)).toMatch(/уже/)
      expect(asRows(r)).toHaveLength(0)
    })
  })
  describe('a press on a card is safe (review: the card is not spent for nothing)', () => {
    type Sent = { text: string; author: 'sara' | 'boris'; o?: SendOptions }
    let sent: Sent[]
    const live = () => ({
      db,
      notifier,
      sendText: async (_c: string, text: string, author: 'sara' | 'boris', o?: SendOptions) => {
        sent.push({ text, author, o })
        return 'Отправила клиенту.'
      },
    })
    const stateOf = async (id: string) => (await db.select().from(task).where(eq(task.id, id)))[0]
    const asRows = (r: unknown) =>
      (r as { rows?: { text: string; callbackData: string }[][] } | null)?.rows?.flat() ?? []

    beforeEach(async () => {
      sent = []
      await setSetting(db, 'conv.v1_writes', false, 'system')
      await setSetting(db, 'outbound.messages', true, 'system')
      await db
        .insert(account)
        .values({ id: 'hance-marketing', title: 'Hance', egressIp: '127.0.0.1' })
        .onConflictDoNothing()
    })

    it('FR-OPS-1: a press during the «Пишет клиентам» pause says why and keeps the card for later', async () => {
      await setSetting(db, 'outbound.messages', false, 'system')
      expect(await onConvPress(live(), { taskId: cardTask, action: 'send' })).toBe(
        'Сейчас не отправляю: пауза «Пишет клиентам». Карточка остаётся, нажми позже.',
      )
      expect(sent).toEqual([])
      expect((await stateOf(cardTask))?.state).toBe('open')
      await setSetting(db, 'outbound.messages', true, 'system')
      expect(await onConvPress(live(), { taskId: cardTask, action: 'send' })).toBe(
        'Отправила клиенту.',
      )
      expect(sent).toHaveLength(1)
    })

    it('FR-OPS-1: an account on pause, logged out or banned keeps the card open too', async () => {
      await db.update(account).set({ paused: true }).where(eq(account.id, 'hance-marketing'))
      expect(await onConvPress(live(), { taskId: cardTask, action: 'send' })).toMatch(
        /аккаунт на паузе/,
      )
      await db
        .update(account)
        .set({ paused: false, loginState: 'dead' })
        .where(eq(account.id, 'hance-marketing'))
      expect(await onConvPress(live(), { taskId: cardTask, action: 'send' })).toMatch(
        /не вошёл в Профи\.ру/,
      )
      expect(sent).toEqual([])
      expect((await stateOf(cardTask))?.state).toBe('open')
    })

    it('FR-CONV-5: back in shadow the press does not spend the card either', async () => {
      await setSetting(db, 'conv.v1_writes', true, 'system')
      expect(await onConvPress(live(), { taskId: cardTask, action: 'send' })).toMatch(/Режим тени/)
      expect((await stateOf(cardTask))?.state).toBe('open')
    })

    it('FR-OPS-1: his own text passes the «Пишет клиентам» pause, but not an account on pause, and the confirmation stays', async () => {
      await onConvPress(live(), { taskId: cardTask, action: 'edit' })
      const r = await onConvReply(live(), {
        replyToMessageId: cardMessage,
        text: 'Анна, давайте в пятницу',
        at: new Date(),
      })
      const sayTask = asRows(r)[0]?.callbackData.split(':')[1] ?? ''
      await db.update(account).set({ paused: true }).where(eq(account.id, 'hance-marketing'))
      expect(await onConvPress(live(), { taskId: sayTask, action: 'send' })).toMatch(
        /аккаунт на паузе/,
      )
      expect(sent).toEqual([])
      expect((await stateOf(sayTask))?.state).toBe('open')
      expect((await stateOf(cardTask))?.state).toBe('open')
      await db.update(account).set({ paused: false }).where(eq(account.id, 'hance-marketing'))
      await setSetting(db, 'outbound.messages', false, 'system')
      expect(await onConvPress(live(), { taskId: sayTask, action: 'send' })).toBe(
        'Отправила клиенту.',
      )
      expect(sent).toHaveLength(1)
    })

    it('FR-CONV-9: a draft is refused when another card of the same turn already sent it', async () => {
      // Two cards for one turn (a card that went out twice); the first one was pressed and its message is out.
      const twin = newEventId()
      await db.insert(task).values({
        id: twin,
        kind: 'conv_draft',
        entityKind: 'conv_turn',
        entityId: 't-1',
        telegramMessageId: 777,
      })
      for (const [state, expected] of [
        ['confirmed', /Ответ уже ушёл/],
        ['queued', /Ответ уже ушёл/],
        ['uncertain', /Не уверена, что прошлая отправка дошла/],
      ] as const) {
        await db.delete(outbox)
        await db.insert(outbox).values({
          id: newEventId(),
          kind: 'message',
          idempotencyKey: `msg:send:${cardTask}`,
          payload: { chatId: CHAT, accountId: 'hance-marketing', text: 'Начнём', author: 'sara' },
          state,
        })
        expect(await onConvPress(live(), { taskId: twin, action: 'send' })).toMatch(expected)
      }
      expect(sent).toEqual([])
      expect((await stateOf(twin))?.state).toBe('open')
      // A send that failed does not stop the other card.
      await db.update(outbox).set({ state: 'failed' })
      expect(await onConvPress(live(), { taskId: twin, action: 'send' })).toBe('Отправила клиенту.')
    })

    it('FR-CONV-11: «напиши» through the pult answers the card behind it: the draft cannot go too', async () => {
      expect(await say(live(), convId, 'Анна, давайте в пятницу')).toBe('Отправила клиенту.')
      expect((await stateOf(cardTask))?.state).toBe('resolved')
      expect((await stateOf(cardTask))?.resolution).toBe('say')
      expect(await onConvPress(live(), { taskId: cardTask, action: 'send' })).toMatch(/уже/)
      expect(sent).toHaveLength(1)
    })
  })
})
