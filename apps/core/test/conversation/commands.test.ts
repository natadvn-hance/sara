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
import { ensureConversation, getConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import { convTurn, deal, lead, mindProposal, question, task } from '../../src/db/schema'
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
})
