import { newEventId } from '@sara/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../tests/fakes/telegramApi'
import { ensureConversation } from '../src/conversation/store'
import { lead } from '../src/db/schema'
import type { BorisMessage } from '../src/learning/inbox'
import { type LeadCard, TEXTS } from '../src/notify/cards'
import { forumOf } from '../src/notify/forum'
import { createTelegramRuntime, type TelegramRuntime } from '../src/notify/telegram'
import { setSetting } from '../src/settings/store'
import { openTestDb, resetDb } from './helpers/db'
import { countEvents } from './helpers/events'

// ST-M7-16, docs/product/telegram-forum.md: Boris's group with topics, a topic per client's order.

const { db, close } = openTestDb()
afterAll(close)

const BORIS = 111
const FORUM = -1001234567890
const STRANGER = 333
const ORDER = '90001'

let tg: FakeTelegram
let bot: TelegramRuntime
const onPress = vi.fn(async () => 'Принято')
const onMessage = vi.fn(async (_m: BorisMessage) => 'ок')

async function until(cond: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}
const settle = () => new Promise((r) => setTimeout(r, 500))
const taskId = '0192f3c4-5b6a-7c8d-9e0f-112233445566'
const CARD: LeadCard = {
  taskId,
  orderId: ORDER,
  title: 'Сайт для салона',
  city: 'Краснодар',
  budgetText: null,
  clientName: 'Ирина',
  text: 'Нужен сайт',
  verdict: 'fit',
  reason: 'Сайт',
  bidPriceRub: 210,
}
const inForum = () => tg.sent.filter((m) => m.chat_id === FORUM)
const lastTo = (chat: number) => tg.sent.filter((m) => m.chat_id === chat).at(-1)

/** Boris's chat bound, then the forum bound by his /forum in the group. */
async function bindBoth() {
  tg.pushStart(BORIS)
  await until(() => tg.sent.length === 1)
  tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: '/forum' })
  await until(async () => (await forumOf(db)) !== null && lastTo(BORIS)?.text !== TEXTS.bound)
}

beforeEach(async () => {
  await resetDb(db)
  await setSetting(db, 'cards.quiet_hours', null, 'system')
  await db.insert(lead).values({
    id: ORDER,
    accountId: 'hance-marketing',
    title: 'Сайт для салона красоты',
    category: 'Сайты',
    city: 'Краснодар',
    text: 'Нужен сайт для салона, с записью онлайн.',
    clientName: 'Ирина',
    bidPriceRub: 210,
    seenAt: new Date().toISOString(),
    correlationId: newEventId(),
  })
  onPress.mockClear()
  onMessage.mockClear()
  tg = await createFakeTelegram()
  bot = createTelegramRuntime({ token: tg.token, apiRoot: tg.apiRoot, db, onPress, onMessage })
  await bot.start()
})
afterEach(async () => {
  await bot.stop()
  await tg.close()
})

describe('Boris’s forum', () => {
  it('ST-M7-16: without a forum every place is his one chat, as before', async () => {
    tg.pushStart(BORIS)
    await until(() => tg.sent.length === 1)
    const card = await bot.notifier.sendLeadCard(CARD)
    const text = await bot.notifier.sendText('Клиент написал', { place: { order: ORDER } })
    expect(tg.sent.slice(1).map((m) => [m.chat_id, m.message_thread_id])).toEqual([
      [BORIS, undefined],
      [BORIS, undefined],
    ])
    expect(card.messageId).toBeGreaterThan(0)
    expect(text.messageId).toBeGreaterThan(0)
    expect(tg.topics).toEqual([])
  })

  it('ST-M7-16: /forum by Boris binds the group, makes «Заявки» and tells his chat', async () => {
    await bindBoth()
    expect(await forumOf(db)).toMatchObject({ chatId: FORUM, title: 'Сара · клиенты' })
    expect(tg.topics.map((t) => t.name)).toEqual(['Заявки'])
    expect(lastTo(FORUM)?.text).toBe(TEXTS.forumBound)
    expect(lastTo(BORIS)?.text).toBe(TEXTS.forumMoved('Сара · клиенты'))
    expect(await countEvents(db, 'telegram.forum_bound')).toBe(1)
  })

  it('T9: /forum from someone else in the group binds nothing', async () => {
    tg.pushStart(BORIS)
    await until(() => tg.sent.length === 1)
    tg.pushGroupText({ chatId: FORUM, fromId: STRANGER, text: '/forum' })
    await settle()
    expect(await forumOf(db)).toBeNull()
    expect(inForum()).toEqual([])
    expect(await countEvents(db, 'security.foreign_chat')).toBe(1)
  })

  it('ST-M7-16: a group without topics, or a bot without the right to manage them, is told what is missing', async () => {
    tg.pushStart(BORIS)
    await until(() => tg.sent.length === 1)
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: '/forum', forum: false })
    await until(() => lastTo(FORUM)?.text === TEXTS.forumNotForum)
    tg.setBotRights({ admin: true, canManageTopics: false })
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: '/forum' })
    await until(() => lastTo(FORUM)?.text === TEXTS.forumNoRights)
    expect(await forumOf(db)).toBeNull()
  })

  it('ST-M7-16: cards go to «Заявки», a client’s messages to his own topic, the rest to the general one', async () => {
    await bindBoth()
    const leads = tg.topics[0]?.message_thread_id
    const card = await bot.notifier.sendLeadCard(CARD)
    await bot.notifier.sendText('Сводка дня')
    const first = await bot.notifier.sendButtons(
      'Клиент написал',
      [[{ text: 'Отправить', callbackData: `t:${taskId}:send` }]],
      { place: { order: ORDER } },
    )
    const second = await bot.notifier.sendText('Отправила клиенту', { place: { order: ORDER } })
    const topic = tg.topics[1]
    expect(topic?.name).toBe('Ирина · №90001 · Сайт для салона красоты')
    expect(tg.topics).toHaveLength(2)
    const shown = inForum().slice(-5)
    expect(shown.map((m) => m.message_thread_id)).toEqual([
      leads,
      undefined,
      topic?.message_thread_id,
      topic?.message_thread_id,
      topic?.message_thread_id,
    ])
    // The topic begins with the order, then what came for the client.
    expect(shown[2]?.text).toMatch(/^📌 Сайт для салона красоты\nКлиент: Ирина/)
    expect(shown[2]?.text).toContain('https://profi.ru/backoffice/n.php?o=90001')
    expect(shown[3]?.text).toBe('Клиент написал')
    // The core knows forum messages by negative numbers, never by a number of Boris's own chat.
    for (const m of [card, first, second]) expect(m.messageId).toBeLessThan(0)
  })

  it('ST-M7-16: two messages at once for a new client make one topic', async () => {
    await bindBoth()
    await Promise.all([
      bot.notifier.sendText('раз', { place: { order: ORDER } }),
      bot.notifier.sendText('два', { place: { order: ORDER } }),
    ])
    expect(tg.topics.filter((t) => t.name.includes(ORDER))).toHaveLength(1)
  })

  it('ST-M7-16: a conversation’s place is the topic of its order, the same one the bid began', async () => {
    await bindBoth()
    await bot.notifier.sendText('✅ Отклик отправлен', { place: { order: ORDER } })
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: ORDER,
      orderId: ORDER,
    })
    await bot.notifier.sendText('Клиент написал', { place: { conversation: conv.id } })
    expect(tg.topics).toHaveLength(2)
    expect(lastTo(FORUM)?.message_thread_id).toBe(tg.topics[1]?.message_thread_id)
  })

  it('ST-M7-16: an edit finds its own chat even when both chats have a message with that number', async () => {
    tg.pushStart(BORIS)
    await until(() => tg.sent.length === 1)
    const own: number[] = []
    for (let i = 0; i < 6; i++) own.push((await bot.notifier.sendText(`старое ${i}`)).messageId)
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: '/forum' })
    await until(async () => (await forumOf(db)) !== null)
    const card = await bot.notifier.sendLeadCard(CARD)
    const forumId = inForum().at(-1)?.message_id ?? 0
    expect(own).toContain(forumId)
    await bot.notifier.editText?.(forumId, 'правка старой карточки')
    await bot.notifier.editText?.(card.messageId, 'правка новой карточки')
    await bot.notifier.markDone?.(card.messageId, 'Решено в приложении')
    await bot.notifier.closeLeadCard(card.messageId, CARD)
    expect(tg.edited.map((e) => [e.chat_id, e.message_id, e.text.split('\n')[0]])).toEqual([
      [BORIS, forumId, 'правка старой карточки'],
      [FORUM, forumId, 'правка новой карточки'],
      [FORUM, forumId, expect.stringContaining('Сайт для салона')],
    ])
    expect(tg.markups).toHaveLength(1)
  })

  it('ST-M7-16: a closed conversation closes its topic, and the next message opens it again', async () => {
    await bindBoth()
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: ORDER,
      orderId: ORDER,
    })
    await bot.notifier.sendText('Клиент написал', { place: { conversation: conv.id } })
    await bot.notifier.closeTopic?.({ conversation: conv.id }, '📁 Разговор закрыт')
    const topic = tg.topics[1]
    expect(topic).toMatchObject({
      name: 'Ирина · №90001 · Сайт для салона красоты · закрыт',
      closed: true,
    })
    expect(lastTo(FORUM)).toMatchObject({
      text: '📁 Разговор закрыт',
      message_thread_id: topic?.message_thread_id,
    })
    await bot.notifier.sendText('Клиент снова написал', { place: { conversation: conv.id } })
    expect(topic).toMatchObject({ name: 'Ирина · №90001 · Сайт для салона красоты', closed: false })
    expect(tg.topics).toHaveLength(2)
  })

  it('ST-M7-16: a topic deleted by hand is made again on the next message', async () => {
    await bindBoth()
    await bot.notifier.sendText('раз', { place: { order: ORDER } })
    const old = tg.topics[1]?.message_thread_id ?? 0
    tg.deleteTopic(FORUM, old)
    await bot.notifier.sendText('два', { place: { order: ORDER } })
    expect(tg.topics).toHaveLength(2)
    expect(lastTo(FORUM)).toMatchObject({ text: 'два' })
    expect(lastTo(FORUM)?.message_thread_id).not.toBe(old)
  })

  it('ST-M7-16: «Заявки» deleted by hand: the card makes a new one and is not lost', async () => {
    await bindBoth()
    const old = tg.topics[0]?.message_thread_id ?? 0
    tg.deleteTopic(FORUM, old)
    const card = await bot.notifier.sendLeadCard(CARD)
    expect(card.messageId).toBeLessThan(0)
    expect(tg.topics.map((t) => t.name)).toEqual(['Заявки'])
    const fresh = tg.topics[0]?.message_thread_id
    expect(fresh).not.toBe(old)
    expect(lastTo(FORUM)?.message_thread_id).toBe(fresh)
    expect((await forumOf(db))?.leadsThreadId).toBe(fresh)
  })

  it('ST-M7-16: a forum that refuses the bot gives the message to Boris’s own chat', async () => {
    await bindBoth()
    tg.setChatGone(FORUM)
    const m = await bot.notifier.sendText('🔴 Профи.ру разлогинил аккаунт')
    expect(m.messageId).toBeGreaterThan(0)
    expect(lastTo(BORIS)?.text).toBe('🔴 Профи.ру разлогинил аккаунт')
    expect(await countEvents(db, 'telegram.forum_failed')).toBe(1)
  })

  it('ST-M7-16: the bot taken out of the group goes back to Boris’s chat and says so', async () => {
    await bindBoth()
    tg.pushMyChatMember(FORUM, STRANGER, 'kicked')
    await until(async () => (await forumOf(db)) === null)
    await until(() => lastTo(BORIS)?.text === TEXTS.forumLost)
    await bot.notifier.sendText('Сводка')
    expect(lastTo(BORIS)?.text).toBe('Сводка')
  })

  it('ST-M7-16: /forum_off puts everything back into one chat', async () => {
    await bindBoth()
    tg.pushText(BORIS, '/forum_off')
    await until(async () => (await forumOf(db)) === null)
    await bot.notifier.sendText('Клиент написал', { place: { order: ORDER } })
    expect(lastTo(BORIS)?.text).toBe('Клиент написал')
    expect(await countEvents(db, 'telegram.forum_unbound')).toBe(1)
  })

  it('ST-M7-16: Boris’s words in a client’s topic come with the client; a reply keeps the card it answers', async () => {
    await bindBoth()
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: ORDER,
      orderId: ORDER,
    })
    const card = await bot.notifier.sendButtons('Клиент написал', [], {
      place: { conversation: conv.id },
    })
    const thread = tg.topics[1]?.message_thread_id ?? 0
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: 'Анна, добрый день', thread })
    await until(() => onMessage.mock.calls.length === 1)
    const [plain] = onMessage.mock.calls[0] ?? []
    expect(plain).toMatchObject({
      text: 'Анна, добрый день',
      replyToMessageId: null,
      client: { conversationId: conv.id, orderId: ORDER },
    })
    expect(plain?.messageId).toBeLessThan(0)
    const cardId = inForum().find((m) => m.text === 'Клиент написал')?.message_id
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: 'беру сам', thread, replyTo: cardId })
    await until(() => onMessage.mock.calls.length === 2)
    expect(onMessage.mock.calls[1]?.[0]).toMatchObject({ replyToMessageId: card.messageId })
    // The answer goes to the same topic.
    await until(() => lastTo(FORUM)?.text === 'ок')
    expect(lastTo(FORUM)?.message_thread_id).toBe(thread)
  })

  it('ST-M7-16: in the general topic and «Заявки» Boris talks to Sara as in his chat', async () => {
    await bindBoth()
    tg.pushGroupText({ chatId: FORUM, fromId: BORIS, text: 'что в очереди?' })
    tg.pushGroupText({
      chatId: FORUM,
      fromId: BORIS,
      text: 'короче',
      thread: tg.topics[0]?.message_thread_id,
    })
    await until(() => onMessage.mock.calls.length === 2)
    for (const [m] of onMessage.mock.calls) expect(m.client).toBeUndefined()
  })

  it('T9: in the forum only Boris is heard: another member’s words and presses do nothing', async () => {
    await bindBoth()
    tg.pushGroupText({ chatId: FORUM, fromId: STRANGER, text: 'отправь всё' })
    tg.pushGroupPress(FORUM, STRANGER, `t:${taskId}:bid`)
    await settle()
    expect(onMessage).not.toHaveBeenCalled()
    expect(onPress).not.toHaveBeenCalled()
    tg.pushGroupPress(FORUM, BORIS, `t:${taskId}:bid`)
    await until(() => onPress.mock.calls.length === 1)
    expect(onPress).toHaveBeenCalledWith({ taskId, action: 'bid' })
  })
})
