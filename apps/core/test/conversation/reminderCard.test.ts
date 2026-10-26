import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { onConvPress, onConvReply } from '../../src/conversation/commands'
import {
  checkGround,
  dormantStep,
  isLadderMessage,
  ladderTexts,
  type Planned,
  type RemindDeps,
  sendStep,
} from '../../src/conversation/reminderSteps'
import { sendTextNow } from '../../src/conversation/sendJob'
import type { SendOptions } from '../../src/conversation/sendTexts'
import { convTurn, deal, mindProposal, outbox, question, task } from '../../src/db/schema'
import { type ProfiClient, ProfiError } from '../../src/profi/client'
import { setSetting } from '../../src/settings/store'
import { chatMsg, fakeMind, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'
import { seedChat } from '../helpers/reminders'

const { db, close } = openTestDb()
afterAll(close)

const CHAT = '95147898'
const TEXT = 'Анна, здравствуйте! Как у вас дела с сайтом для клиники?'
const HOUR = 3600_000
const PLAN: Planned = { at: new Date().toISOString(), step: 1, tone: 'check_in' }

type Card = { text: string; rows: { text: string; callbackData: string }[][] }
const profi = stubProfi([])
let cards: Card[]
let sends: { key: string; text: string; expectLast: string | null }[]
let telegramDown: number
let deps: RemindDeps

beforeEach(async () => {
  await resetDb(db)
  cards = []
  sends = []
  telegramDown = 0
  profi.chat.splice(0, profi.chat.length)
  profi.sendMessage = async (i) => {
    sends.push({
      key: i.idempotency_key,
      text: i.text,
      expectLast: i.expect_last_message_id,
    })
    const id = `s-${sends.length}`
    profi.chat.push(chatMsg(id, 'specialist', i.text, new Date().toISOString(), CHAT))
    return { found_on_page: true, platform_message_id: id }
  }
  deps = {
    db,
    profi: profi as ProfiClient,
    gateway: null as unknown as RemindDeps['gateway'],
    mind: fakeMind(),
    notifier: {
      sendButtons: async (text, rows) => {
        if (telegramDown-- > 0) throw new Error('telegram is down')
        cards.push({ text, rows })
        return { messageId: 500 + cards.length }
      },
    },
  }
  await setSetting(db, 'pipeline.conversations', true, 'system')
  // After the switch, the drafts mode: the autopilot stays at its default, off.
  await setSetting(db, 'conv.v1_writes', false, 'system')
  await setSetting(db, 'outbound.messages', true, 'system')
})

/** Our message a day ago that the client did not answer, and the trace row of the first reminder step. */
async function scene(step: 1 | 2 | 3 = 1) {
  const at = new Date(Date.now() - 25 * HOUR).toISOString()
  const conv = await seedChat(db, CHAT, [
    { id: 'm-1', side: 'specialist', text: 'Добрый день', at },
  ])
  profi.chat.push(chatMsg('m-1', 'specialist', 'Добрый день', at, CHAT))
  return { conv, rowId: await addRow(conv.id, step) }
}

async function addRow(conversationId: string, step: 1 | 2 | 3) {
  const rowId = `conv-remind:${conversationId}:m-1:${step}`
  await db.insert(convTurn).values({
    id: rowId,
    conversationId,
    kind: 'reminder',
    anchorMessageId: 'm-1',
    state: 'waiting',
    text: TEXT,
    understanding: { step, tone: 'check_in' },
  })
  return rowId
}

const row = async (id: string) => (await db.select().from(convTurn).where(eq(convTurn.id, id)))[0]
const taskOf = async (rowId: string) =>
  (await db.select().from(task).where(eq(task.entityId, rowId)))[0]
const outboxMessages = async () =>
  (await db.select().from(outbox)).filter((o) => o.kind === 'message')
const actions = (c: Card | undefined) => c?.rows.flat().map((b) => b.callbackData.split(':')[2])

const commandDeps = () => ({
  db,
  notifier: { sendText: async () => ({ messageId: 900 }) },
  sendText: (c: string, text: string, author: 'sara' | 'boris', o?: SendOptions) =>
    sendTextNow(
      { db, profi, ground: (cv, a) => checkGround(deps, cv, a, { dormant: false }) },
      c,
      text,
      author,
      o,
    ),
})
const press = (taskId: string, action: 'send' | 'edit' | 'skip') =>
  onConvPress(commandDeps(), { taskId, action })

/** The card of the step is sent: the state after the reminder process woke up in drafts mode. */
async function carded(step: 1 | 2 | 3 = 1) {
  const s = await scene(step)
  const r = await sendStep(deps, s.rowId, s.conv.id, 'm-1', { ...PLAN, step }, TEXT)
  expect(r.outcome).toBe('carded')
  const t = await taskOf(s.rowId)
  return { ...s, taskId: t?.id ?? '' }
}

describe('the card of a reminder', () => {
  it('FR-CONV-12: with the autopilot off the step sends Boris a card and queues nothing', async () => {
    const { conv, rowId } = await scene()
    const r = await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)
    expect(r).toEqual({ outcome: 'carded', end: false })
    expect(cards).toHaveLength(1)
    const text = cards[0]?.text ?? ''
    expect(text).toContain('Напомнить клиенту?')
    expect(text).toContain('Анна')
    expect(text).toContain('Сайт для клиники')
    expect(text).toContain('Первое напоминание')
    expect(text).toContain(TEXT)
    expect(text).not.toMatch(/[\u2013\u2014]/)
    expect(actions(cards[0])).toEqual(['send', 'edit', 'skip'])
    expect(cards[0]?.rows.flat().map((b) => b.text)).toEqual(['Отправить', 'Изменить', 'Не надо'])
    expect(await outboxMessages()).toHaveLength(0)
    expect(sends).toHaveLength(0)
    const t = await taskOf(rowId)
    expect(t).toMatchObject({ kind: 'conv_draft', entityKind: 'conv_turn', state: 'open' })
    expect(await row(rowId)).toMatchObject({
      state: 'finished',
      outcome: 'carded',
      decision: 'draft',
      taskId: t?.id,
      cardMessageId: 501,
      text: TEXT,
    })
    expect(await countEvents(db, 'conv.reminder_drafted')).toBe(1)
    expect(await countEvents(db, 'conv.reminder_sent')).toBe(0)
  })

  it('FR-CONV-12: a repeat of the step after a crash sends no second card', async () => {
    const { conv, rowId } = await scene()
    await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)
    expect((await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)).outcome).toBe('carded')
    expect(cards).toHaveLength(1)
    expect(await db.select().from(task)).toHaveLength(1)
    expect(await countEvents(db, 'conv.reminder_drafted')).toBe(1)
  })

  it('FR-CONV-12: a card that Telegram would not take leaves the row open to be tried again', async () => {
    const { conv, rowId } = await scene()
    telegramDown = 1
    const r = await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)
    expect(r).toEqual({ outcome: 'failed', end: false, retry: true })
    expect((await row(rowId))?.state).toBe('waiting')
    expect(await db.select().from(task)).toHaveLength(0)
    expect((await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)).outcome).toBe('carded')
    expect(cards).toHaveLength(1)
  })

  it('FR-CONV-5: in shadow no card comes, only the trace', async () => {
    const { conv, rowId } = await scene()
    await setSetting(db, 'conv.v1_writes', true, 'system')
    expect((await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)).outcome).toBe('drafted')
    expect(cards).toHaveLength(0)
    expect(await db.select().from(task)).toHaveLength(0)
  })

  it('FR-CONV-12: the autopilot on sends the reminder by itself, as before, and no card comes', async () => {
    const { conv, rowId } = await scene()
    await setSetting(db, 'conv.autopilot', true, 'system')
    expect((await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)).outcome).toBe('sent')
    expect(cards).toHaveLength(0)
    expect(sends).toHaveLength(1)
  })

  it('FR-CONV-12: the next reminder card closes the one Boris has not answered', async () => {
    const { conv, rowId, taskId } = await carded(1)
    const second = await addRow(conv.id, 2)
    expect((await sendStep(deps, second, conv.id, 'm-1', { ...PLAN, step: 2 }, TEXT)).outcome).toBe(
      'carded',
    )
    expect(cards).toHaveLength(2)
    expect(cards[1]?.text).toContain('Второе напоминание')
    const [old] = await db.select().from(task).where(eq(task.id, taskId))
    expect(old).toMatchObject({ state: 'resolved', resolution: 'expired' })
    expect((await row(rowId))?.outcome).toBe('expired')
    expect(await press(taskId, 'send')).toMatch(/уже/)
    expect(sends).toHaveLength(0)
  })
})

describe('Boris answers the card of a reminder', () => {
  it('FR-CONV-12: «Отправить» sends the text once, with the key of the card and the last message of the chat', async () => {
    const { rowId, taskId } = await carded()
    expect(await press(taskId, 'send')).toBe('Отправила напоминание клиенту.')
    expect(sends).toEqual([{ key: `msg:send:${taskId}`, text: TEXT, expectLast: 'm-1' }])
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    expect(t).toMatchObject({ state: 'resolved', resolution: 'send' })
    expect(await row(rowId)).toMatchObject({ outcome: 'sent', decision: 'send' })
    expect(await countEvents(db, 'conv.reminder_sent')).toBe(1)
    const queued = await outboxMessages()
    expect(queued).toHaveLength(1)
    expect(queued[0]?.state).toBe('confirmed')
    // The same press delivered again sends nothing.
    expect(await press(taskId, 'send')).toMatch(/уже/)
    expect(sends).toHaveLength(1)
  })

  it('FR-CONV-12: two cards of one step never send the reminder twice', async () => {
    const { rowId, taskId } = await carded()
    // A card that went out twice (a crash between Telegram and the database) has two tasks for one step.
    const twin = newEventId()
    await db.insert(task).values({
      id: twin,
      kind: 'conv_draft',
      entityKind: 'conv_turn',
      entityId: rowId,
      telegramMessageId: 999,
    })
    expect(await press(taskId, 'send')).toBe('Отправила напоминание клиенту.')
    expect(await press(twin, 'send')).toMatch(/уже/)
    expect(sends).toHaveLength(1)
    expect(await outboxMessages()).toHaveLength(1)
  })

  it('FR-CONV-12: «Не надо» sends nothing and closes the step, the row says so', async () => {
    const { rowId, taskId } = await carded()
    expect(await press(taskId, 'skip')).toMatch(/не отправляю/)
    expect(sends).toHaveLength(0)
    expect(await outboxMessages()).toHaveLength(0)
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    expect(t).toMatchObject({ state: 'resolved', resolution: 'skip' })
    expect(await row(rowId)).toMatchObject({ outcome: 'declined', decision: 'nothing' })
    // The answer of one press is final: «Отправить» after «Не надо» does nothing.
    expect(await press(taskId, 'send')).toMatch(/уже/)
    expect(sends).toHaveLength(0)
  })

  it('FR-CONV-6: a client who wrote since the card gets no reminder, the card is closed', async () => {
    const { rowId, taskId } = await carded()
    profi.chat.push(chatMsg('m-2', 'client', 'Да, давайте', new Date().toISOString(), CHAT))
    expect(await press(taskId, 'send')).toMatch(/клиент ответил/)
    expect(sends).toHaveLength(0)
    expect(await outboxMessages()).toHaveLength(0)
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    expect(t).toMatchObject({ state: 'resolved', resolution: 'stale' })
    expect(await row(rowId)).toMatchObject({ outcome: 'stopped' })
  })

  it('FR-CONV-6: our side that wrote since the card (Boris himself) keeps the reminder from going', async () => {
    const { taskId } = await carded()
    profi.chat.push(
      chatMsg('m-2', 'specialist', 'Анна, я на связи', new Date().toISOString(), CHAT),
    )
    expect(await press(taskId, 'send')).toMatch(/наша сторона уже написала/)
    expect(sends).toHaveLength(0)
  })

  it('FR-CONV-9: a chat that moved on after the reread is refused by the service and Boris is told', async () => {
    const { rowId, taskId } = await carded()
    profi.sendMessage = async () => {
      throw new ProfiError('CHAT_CHANGED', 'moved on')
    }
    expect(await press(taskId, 'send')).toMatch(/Клиент успел написать/)
    expect(await row(rowId)).toMatchObject({ outcome: 'stopped' })
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    expect(t?.resolution).toBe('stale')
  })

  it('FR-OPS-1: a pause that came after the card holds the press, the card stays open for later', async () => {
    const { rowId, taskId } = await carded()
    await setSetting(db, 'outbound.messages', false, 'system')
    expect(await press(taskId, 'send')).toMatch(/Сейчас не могу отправить напоминание/)
    expect(sends).toHaveLength(0)
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    expect(t?.state).toBe('open')
    expect((await row(rowId))?.outcome).toBe('carded')
    await setSetting(db, 'outbound.messages', true, 'system')
    expect(await press(taskId, 'send')).toBe('Отправила напоминание клиенту.')
    expect(sends).toHaveLength(1)
  })

  it('FR-CONV-11: «да» in reply to the card sends nothing, it points at the card’s «Отправить»', async () => {
    const { taskId } = await carded()
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    const answer = await onConvReply(commandDeps(), {
      replyToMessageId: t?.telegramMessageId ?? null,
      text: 'да',
      at: new Date(),
    })
    expect(answer).toEqual({
      text: 'Нажми «Отправить», и уйдёт',
      rows: [[{ text: 'Отправить', callbackData: `t:${taskId}:send` }]],
    })
    expect(sends).toHaveLength(0)
    // The press of that button is the one that sends.
    expect(await press(taskId, 'send')).toBe('Отправила напоминание клиенту.')
    expect(sends.map((s) => s.text)).toEqual([TEXT])
  })

  it('FR-CONV-11: «Изменить» takes his text, shows it back, and it goes as his own only on «Отправить», once', async () => {
    const { rowId, taskId } = await carded()
    expect(await press(taskId, 'edit')).toMatch(/Жду твой вариант/)
    const [q] = await db.select().from(question)
    expect(q).toMatchObject({ kind: 'conv_edit', entityId: rowId })
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    const mine = 'Анна, добрый день! Как успехи с сайтом?'
    const reply = {
      replyToMessageId: t?.telegramMessageId ?? null,
      text: mine,
      messageId: 4711,
      at: new Date(),
    }
    const asked = await onConvReply(commandDeps(), reply)
    expect(asked).toMatchObject({ text: `Отправлю клиенту так: «${mine}»` })
    expect(sends).toHaveLength(0)
    // The same Telegram message delivered twice is one question.
    expect(typeof (await onConvReply(commandDeps(), reply))).toBe('string')
    const confirm = (asked as { rows: { callbackData: string }[][] }).rows[0]?.[0]?.callbackData
    const sayTask = confirm?.split(':')[1] ?? ''
    expect(await press(sayTask, 'send')).toBe('Отправила напоминание клиенту.')
    expect(sends).toEqual([{ key: 'msg:say:tg:4711', text: mine, expectLast: 'm-1' }])
    expect(await row(rowId)).toMatchObject({ outcome: 'sent', borisText: mine })
    const [closed] = await db.select().from(task).where(eq(task.id, taskId))
    expect(closed).toMatchObject({ state: 'resolved', resolution: 'edit' })
    // The text is Boris's: «Отправить» on the same card, or on his confirmation again, sends nothing more.
    expect(await press(taskId, 'send')).toMatch(/уже/)
    expect(await press(sayTask, 'send')).toMatch(/уже/)
    expect(sends).toHaveLength(1)
    expect(await countEvents(db, 'conv.reminder_sent')).toBe(1)
  })

  it('FR-CONV-11: «Изменить» leaves no speech example: a reminder has no client words to answer', async () => {
    const { taskId } = await carded()
    await press(taskId, 'edit')
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    const asked = await onConvReply(commandDeps(), {
      replyToMessageId: t?.telegramMessageId ?? null,
      text: 'Анна, добрый день! Как успехи с сайтом?',
      messageId: 4712,
      at: new Date(),
    })
    const confirm = (asked as { rows: { callbackData: string }[][] }).rows[0]?.[0]?.callbackData
    await press(confirm?.split(':')[1] ?? '', 'send')
    expect(await db.select().from(mindProposal)).toHaveLength(0)
  })

  it('FR-OPS-1: a pause when he confirms his text holds it, and the confirmation stays for a second press', async () => {
    const { taskId } = await carded()
    await press(taskId, 'edit')
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    const asked = await onConvReply(commandDeps(), {
      replyToMessageId: t?.telegramMessageId ?? null,
      text: 'Анна, добрый день! Как успехи с сайтом?',
      messageId: 4713,
      at: new Date(),
    })
    const sayTask =
      (asked as { rows: { callbackData: string }[][] }).rows[0]?.[0]?.callbackData.split(':')[1] ??
      ''
    await setSetting(db, 'outbound.messages', false, 'system')
    expect(await press(sayTask, 'send')).toMatch(/Сейчас не могу отправить напоминание/)
    expect(sends).toHaveLength(0)
    await setSetting(db, 'outbound.messages', true, 'system')
    expect(await press(sayTask, 'send')).toBe('Отправила напоминание клиенту.')
    expect(sends).toHaveLength(1)
  })

  it('FR-CONV-12: a press that cannot reread the chat sends nothing', async () => {
    const { taskId } = await carded()
    // The send has no way to read the chat: the reminder is not sent and the card is open again.
    const answer = await onConvPress(
      {
        db,
        notifier: { sendText: async () => ({ messageId: 900 }) },
        sendText: (c, text, author, o) => sendTextNow({ db, profi }, c, text, author, o),
      },
      { taskId, action: 'send' },
    )
    expect(answer).toMatch(/не могу проверить чат/)
    expect(sends).toHaveLength(0)
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    expect(t?.state).toBe('open')
    expect(await press(taskId, 'send')).toBe('Отправила напоминание клиенту.')
  })
})

describe('the ladder knows the reminders that went by Boris’s press', () => {
  it('FR-CONV-12: the text of a pressed reminder and of his own version are the ladder’s, not a new beginning', async () => {
    const { conv, taskId } = await carded()
    expect((await ladderTexts(db, conv.id)).size).toBe(0)
    await press(taskId, 'send')
    const texts = await ladderTexts(db, conv.id)
    expect(texts.size).toBe(1)
    const m = {
      author: 'sara' as const,
      authorBasis: 'outbox' as const,
      text: TEXT,
    }
    expect(isLadderMessage(m, texts)).toBe(true)
    expect(isLadderMessage({ ...m, text: 'Другое' }, texts)).toBe(false)
    // Boris's words after «Изменить» are the ladder's too; a message of his from the page is not.
    expect(isLadderMessage({ ...m, author: 'boris', authorBasis: 'say' }, texts)).toBe(true)
    expect(isLadderMessage({ ...m, author: 'boris', authorBasis: 'after_cutover' }, texts)).toBe(
      false,
    )
  })
})

describe('the silence task', () => {
  /** The ladder as it stood on the ninth day: one row a step, with the outcomes given, and a deal in the bid stage. */
  async function ladder(
    outcomes: Record<1 | 2 | 3, string>,
    o: { clientName?: string | null } = {},
  ) {
    const at = new Date(Date.now() - 9 * 24 * HOUR).toISOString()
    const conv = await seedChat(
      db,
      CHAT,
      [{ id: 'm-1', side: 'specialist', text: 'Добрый день', at }],
      { deal: true, ...(o.clientName === null && { clientName: null }) },
    )
    for (const step of [1, 2, 3] as const) {
      const id = `conv-remind:${conv.id}:m-1:${step}`
      await db.insert(convTurn).values({
        id,
        conversationId: conv.id,
        kind: 'reminder',
        anchorMessageId: 'm-1',
        state: 'finished',
        outcome: outcomes[step],
        text: TEXT,
        understanding: { step, tone: 'check_in' },
      })
      // The cards of steps that wait for Boris are open tasks.
      if (outcomes[step] === 'carded') {
        const taskId = newEventId()
        await db.insert(task).values({
          id: taskId,
          kind: 'conv_draft',
          entityKind: 'conv_turn',
          entityId: id,
          telegramMessageId: 700 + step,
        })
        await db.update(convTurn).set({ taskId }).where(eq(convTurn.id, id))
      }
    }
    // The row of the silence step, as the process makes it when it wakes.
    const rowId = `conv-remind:${conv.id}:m-1:dormant`
    await db.insert(convTurn).values({
      id: rowId,
      conversationId: conv.id,
      kind: 'reminder',
      anchorMessageId: 'm-1',
      state: 'waiting',
      understanding: { step: 'dormant', tone: 'check_in' },
    })
    return { conv, rowId }
  }
  const stage = async () => (await db.select().from(deal))[0]?.stage

  it('FR-CONV-12: the task counts the reminders that really went, not three by default', async () => {
    const { conv, rowId } = await ladder({ 1: 'sent', 2: 'sent', 3: 'declined' })
    await dormantStep(deps, rowId, conv.id, false)
    expect(cards.at(-1)?.text).toContain('клиент молчит после двух напоминаний')
    expect(cards.at(-1)?.text).not.toContain('трёх')
    expect(actions(cards.at(-1))).toEqual(['close'])
    expect(await stage()).toBe('dormant')
  })

  it('FR-CONV-12: three sent reminders read «после трёх напоминаний», one reads «после одного»', async () => {
    const a = await ladder({ 1: 'sent', 2: 'sent', 3: 'sent' })
    await dormantStep(deps, a.rowId, a.conv.id, false)
    expect(cards.at(-1)?.text).toContain('клиент молчит после трёх напоминаний')
    await resetDb(db)
    const b = await ladder({ 1: 'sent', 2: 'declined', 3: 'expired' })
    await dormantStep(deps, b.rowId, b.conv.id, false)
    expect(cards.at(-1)?.text).toContain('клиент молчит после одного напоминания')
  })

  it('FR-CONV-12: when no reminder went (cards ignored, «Не надо», pauses) the task says so and the deal stays', async () => {
    const { conv, rowId } = await ladder({ 1: 'declined', 2: 'skipped', 3: 'expired' })
    await dormantStep(deps, rowId, conv.id, false)
    const text = cards.at(-1)?.text ?? ''
    expect(text).toContain('напоминания ему не уходили')
    expect(text).not.toMatch(/после (одного|двух|трёх)/)
    expect(actions(cards.at(-1))).toEqual(['close'])
    expect(await stage()).toBe('bid_sent')
    // The task is raised all the same: Boris may close the conversation.
    expect((await db.select().from(task)).filter((t) => t.kind === 'conv_dormant')).toHaveLength(1)
    expect(await row(rowId)).toMatchObject({ outcome: 'dormant' })
  })

  it('FR-CONV-12: the task closes the cards that still wait: there is no «third» reminder after «Больше напоминать не буду»', async () => {
    const { conv, rowId } = await ladder({ 1: 'sent', 2: 'sent', 3: 'carded' })
    const waiting = (await db.select().from(task)).find((t) => t.kind === 'conv_draft')
    await dormantStep(deps, rowId, conv.id, false)
    const [t] = await db
      .select()
      .from(task)
      .where(eq(task.id, waiting?.id ?? ''))
    expect(t).toMatchObject({ state: 'resolved', resolution: 'expired' })
    expect(await row(`conv-remind:${conv.id}:m-1:3`)).toMatchObject({ outcome: 'expired' })
    // A press on it later sends nothing.
    await press(waiting?.id ?? '', 'send')
    expect(sends).toHaveLength(0)
    // A repeat of the step (a crash) neither adds a task nor a card.
    await dormantStep(deps, rowId, conv.id, false)
    expect((await db.select().from(task)).filter((x) => x.kind === 'conv_dormant')).toHaveLength(1)
    expect(cards).toHaveLength(1)
  })

  it('FR-CONV-12: a client without a name in the order reads well: «Клиент молчит», not «Клиент: клиент молчит»', async () => {
    const { conv, rowId } = await ladder({ 1: 'sent', 2: 'sent', 3: 'sent' }, { clientName: null })
    await dormantStep(deps, rowId, conv.id, false)
    const first = (cards.at(-1)?.text ?? '').split('\n')[0]
    expect(first).toBe('😴 Клиент молчит после трёх напоминаний.')
  })

  it('FR-CONV-12: with a name and an order the first line names them', async () => {
    const { conv, rowId } = await ladder({ 1: 'sent', 2: 'sent', 3: 'sent' })
    await dormantStep(deps, rowId, conv.id, false)
    expect((cards.at(-1)?.text ?? '').split('\n')[0]).toBe(
      '😴 Анна, заказ «Сайт для клиники»: клиент молчит после трёх напоминаний.',
    )
  })
})
