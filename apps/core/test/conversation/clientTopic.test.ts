import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sendTurnCard } from '../../src/conversation/cards'
import { onClientText, onConvPress } from '../../src/conversation/commands'
import { ensureConversation, getConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import { account, convTurn, deal, lead, task } from '../../src/db/schema'
import { handleBorisMessage } from '../../src/learning/inbox'
import type { Place } from '../../src/notify/notifier'
import { setSetting } from '../../src/settings/store'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

// Boris's words in a client's topic of the forum (docs/product/telegram-forum.md): nothing goes without his press.

const { db, close: closeDb } = openTestDb()
afterAll(closeDb)

const CHAT = '95147898'
type Sent = {
  text: string
  author: 'sara' | 'boris'
  o?: { key?: string; expectLast?: string | null }
}
let sent: Sent[]
let closed: { place: Place; outcome: string }[]
let convId: string
let cardTask: string
let cardMessage: number
const notifier = {
  sendText: async () => ({ messageId: 501 }),
  sendButtons: async () => ({ messageId: 201 }),
  editText: async () => {},
  closeTopic: async (place: { conversation: string }, outcome: string) => {
    closed.push({ place, outcome })
  },
}
const live = () => ({
  db,
  notifier,
  sendText: async (_c: string, text: string, author: 'sara' | 'boris', o?: Sent['o']) => {
    sent.push({ text, author, o })
    return 'Отправила клиенту.'
  },
})
let n = 4000
const inTopic = (text: string, conversationId: string | null = convId) =>
  onClientText(live(), { conversationId, text, voice: false, messageId: -n++, at: new Date() })
const asText = (r: unknown) => (typeof r === 'string' ? r : ((r as { text: string })?.text ?? ''))
const asRows = (r: unknown) =>
  (r as { rows?: { text: string; callbackData: string }[][] } | null)?.rows?.flat() ?? []
const press = (r: unknown, i = 0) => {
  const [, taskId, action] = (asRows(r)[i]?.callbackData ?? '').split(':')
  return onConvPress(live(), { taskId: taskId ?? '', action: (action ?? 'send') as 'send' })
}
const taskOf = async (id: string) => (await db.select().from(task).where(eq(task.id, id)))[0]

beforeEach(async () => {
  await resetDb(db)
  sent = []
  closed = []
  await setSetting(db, 'cards.quiet_hours', null, 'system')
  await setSetting(db, 'conv.v1_writes', false, 'system')
  await setSetting(db, 'outbound.messages', true, 'system')
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
    decision: 'draft',
    decisionReason: 'черновик',
  })
  const r = await sendTurnCard({ db, notifier }, 't-1')
  cardTask = r?.taskId ?? ''
  cardMessage = r?.messageId ?? 0
})

describe('Boris writes in a client’s topic', () => {
  it('ST-M7-16: his words answer the open card, shown back first and sent only on «Отправить»', async () => {
    const words = 'Анна, давайте завтра в 11 созвонимся?'
    const r = await inTopic(words)
    expect(asText(r)).toBe(`Отправлю клиенту так: «${words}»`)
    expect(asRows(r).map((b) => b.text)).toEqual(['Отправить', 'Изменить'])
    expect(sent).toEqual([])
    expect(await press(r)).toBe('Отправила клиенту.')
    expect(sent).toEqual([
      { text: words, author: 'boris', o: expect.objectContaining({ expectLast: 'm-2' }) },
    ])
    // His text answered the card: the draft behind it cannot go too.
    expect((await taskOf(cardTask))?.state).toBe('resolved')
    expect(await press(r)).toMatch(/уже/)
    expect(sent).toHaveLength(1)
  })

  it('ST-M7-16: with no open card his words are a confirmation of their own, against the chat as it was', async () => {
    await onConvPress(live(), { taskId: cardTask, action: 'take' })
    const words = 'Анна, пришлю договор сегодня вечером.'
    const r = await inTopic(words)
    expect(asText(r)).toBe(`Отправлю клиенту так: «${words}»`)
    expect(sent).toEqual([])
    expect(await press(r)).toBe('Отправила клиенту.')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ text: words, author: 'boris', o: { expectLast: 'm-2' } })
    expect(sent[0]?.o?.key).toMatch(/^say:tg:-\d+$/)
    expect(await press(r)).toBe('Это уже сделано.')
    expect(sent).toHaveLength(1)
    expect(await countEvents(db, 'conv.said')).toBe(1)
    // The client stays Boris's: his words change nothing of who leads.
    expect((await getConversation(db, convId))?.owner).toBe('boris')
  })

  it('ST-M7-16: «Изменить» under words with no card asks for new words and sends nothing', async () => {
    await onConvPress(live(), { taskId: cardTask, action: 'take' })
    const r = await inTopic('Анна, добрый день')
    expect(await press(r, 1)).toMatch(/новый вариант/)
    expect(await press(r)).toBe('Это уже сделано.')
    expect(sent).toEqual([])
  })

  it('ST-M7-16: the same Telegram message handled twice asks once', async () => {
    await onConvPress(live(), { taskId: cardTask, action: 'take' })
    const m = {
      conversationId: convId,
      text: 'Анна, в пятницу',
      voice: false,
      messageId: -77,
      at: new Date(),
    }
    expect(asRows(await onClientText(live(), m))).toHaveLength(2)
    expect(asRows(await onClientText(live(), m))).toHaveLength(0)
  })

  it('ST-M7-16: «да» sends nothing and points at the card’s own «Отправить»', async () => {
    const r = await inTopic('Да, отправляй')
    expect(asText(r)).toBe('Нажми «Отправить», и уйдёт')
    expect(asRows(r)).toEqual([{ text: 'Отправить', callbackData: `t:${cardTask}:send` }])
    expect(sent).toEqual([])
    await onConvPress(live(), { taskId: cardTask, action: 'take' })
    expect(asText(await inTopic('да'))).toMatch(/нечего отправлять/)
  })

  it('ST-M7-16: «беру сам» and «закрой» work on the client of the topic; closing closes the topic', async () => {
    expect(await inTopic('беру сам')).toMatch(/Клиент твой/)
    expect((await getConversation(db, convId))?.owner).toBe('boris')
    expect(await inTopic('закрой')).toMatch(/Разговор закрыт/)
    expect((await getConversation(db, convId))?.closedAt).not.toBeNull()
    expect(closed).toEqual([
      { place: { conversation: convId }, outcome: expect.stringMatching(/📁/) },
    ])
    expect(sent).toEqual([])
  })

  it('ST-M7-16: while «Изменить» waits his words in the topic are his version, confirmed before they go', async () => {
    await onConvPress(live(), { taskId: cardTask, action: 'edit' })
    const r = await inTopic('Анна, начнём с аудита сайта')
    expect(asText(r)).toBe('Отправлю клиенту так: «Анна, начнём с аудита сайта»')
    expect(sent).toEqual([])
    expect(await press(r)).toBe('Отправила клиенту.')
    expect(sent[0]).toMatchObject({ text: 'Анна, начнём с аудита сайта', author: 'boris' })
  })

  it('ST-M7-16: a topic whose client has not written yet keeps his words to himself', async () => {
    expect(await inTopic('Анна, добрый день', null)).toMatch(/ещё нет чата/)
    expect(sent).toEqual([])
  })

  it('ST-M7-16: in shadow his words are kept as his answer and go nowhere', async () => {
    await setSetting(db, 'conv.v1_writes', true, 'system')
    expect(await inTopic('Анна, добрый день')).toMatch(/Режим тени/)
    expect(sent).toEqual([])
    const [t] = await db.select().from(convTurn).where(eq(convTurn.id, 't-1'))
    expect(t?.borisText).toBe('Анна, добрый день')
  })

  it('ST-M7-16: an account on pause holds the press and the confirmation stays for later', async () => {
    await onConvPress(live(), { taskId: cardTask, action: 'take' })
    const r = await inTopic('Анна, добрый день')
    await db
      .insert(account)
      .values({ id: 'hance-marketing', title: 'Hance', egressIp: '127.0.0.1', paused: true })
    expect(await press(r)).toMatch(/аккаунт на паузе/)
    expect(sent).toEqual([])
    await db.update(account).set({ paused: false }).where(eq(account.id, 'hance-marketing'))
    expect(await press(r)).toBe('Отправила клиенту.')
    expect(sent).toHaveLength(1)
  })

  it('ST-M7-16: through the inbox a reply to the card is still a command, other words are about the client', async () => {
    const inbox = (text: string, replyTo: number | null) =>
      handleBorisMessage(
        {
          db,
          transcriber: { transcribe: async () => null },
          onCardReply: async (m) =>
            m.replyToMessageId === cardMessage ? 'команда карточке' : null,
          onClientText: (m) => onClientText(live(), m),
        },
        {
          text,
          voicePath: null,
          replyToMessageId: replyTo,
          client: { conversationId: convId, orderId: CHAT },
          messageId: -n++,
          at: new Date(),
        },
      )
    expect(await inbox('беру сам', cardMessage)).toBe('команда карточке')
    expect(asText(await inbox('Анна, добрый день', null))).toBe(
      'Отправлю клиенту так: «Анна, добрый день»',
    )
    expect(sent).toEqual([])
  })
})
