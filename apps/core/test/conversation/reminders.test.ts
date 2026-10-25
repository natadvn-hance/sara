import { DBOS } from '@dbos-inc/dbos-sdk'
import { type ChatMessage, newEventId } from '@sara/shared'
import { asc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { onConvPress } from '../../src/conversation/commands'
import { checkGround } from '../../src/conversation/reminderSteps'
import {
  decideDormant,
  type RemindDeps,
  reminderFallback,
  remindWorkflowId,
  setRemindDeps,
  startReminder,
} from '../../src/conversation/reminders'
import { moscowHour, moscowHoursEnd } from '../../src/conversation/time'
import {
  account,
  chatMessage,
  conversation,
  convTurn,
  deal,
  outbox,
  task,
} from '../../src/db/schema'
import { type ProfiClient, ProfiError } from '../../src/profi/client'
import { setSetting } from '../../src/settings/store'
import { launchDbos, shutdownDbos } from '../../src/workflows/dbos'
import { chatMsg, fakeMind, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb, testDatabaseUrl } from '../helpers/db'
import { countEvents } from '../helpers/events'
import { type FakeGateway, fakeGateway } from '../helpers/gateway'
import { ACC, type SeedMessage, seedChat } from '../helpers/reminders'

const { db, close } = openTestDb()
const CHAT = '95147898'
const HOUR = 3600_000
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const FACTS = ['s-portrait', 'k-process-start']
const GOOD = {
  text: '[имя 1], здравствуйте! Как у вас дела с сайтом для клиники? Удобно вернуться к нему на этой неделе?',
  fact_ids: FACTS,
}
// Four reminders in a row, each in other words: the same text twice would fail robotic.repeat.
const SEQUENCE = {
  $sequence: [
    GOOD,
    {
      text: '[имя 1], добрый день! Вернусь к сайту для клиники: если сейчас не до него, подскажите, когда лучше написать?',
      fact_ids: FACTS,
    },
    {
      text: '[имя 1], здравствуйте! Сайт для клиники всё ещё в планах? Если да, давайте обсудим первые шаги.',
      fact_ids: FACTS,
    },
    {
      text: '[имя 1], здравствуйте! Пишу без спешки: если сайт снова станет нужен, я рядом и помогу с первыми шагами.',
      fact_ids: FACTS,
    },
  ],
}
const GOOD_TEXT =
  'Анна, здравствуйте! Как у вас дела с сайтом для клиники? Удобно вернуться к нему на этой неделе?'

const profi = stubProfi([])
let sends: { key: string; text: string; expectLast: string | null; chatId: string }[]
let reads: number
let onRead: (n: number) => void
let sendFails: ProfiError | null
let fake: FakeGateway
let buttons: { text: string; rows: { text: string; callbackData: string }[][] }[]
let booked: boolean
let deps: RemindDeps

const notifier = {
  sendButtons: async (text: string, rows: { text: string; callbackData: string }[][]) => {
    buttons.push({ text, rows })
    return { messageId: 500 + buttons.length }
  },
}

async function until(cond: () => Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await sleep(100)
  }
  throw new Error('condition not met in time')
}

// Waiting for a durable process takes seconds.
vi.setConfig({ testTimeout: 40_000 })

const rows = () =>
  db
    .select()
    .from(convTurn)
    .where(eq(convTurn.kind, 'reminder'))
    .orderBy(asc(convTurn.createdAt), asc(convTurn.id))
const done = (n: number) => async () => (await rows()).filter((r) => r.finishedAt).length >= n
const outcomes = async () => (await rows()).map((r) => `${r.id.split(':').at(-1)}=${r.outcome}`)
const messageOutbox = async () =>
  (await db.select().from(outbox)).filter((o) => o.kind === 'message')
const statusOf = async (id: string) => (await DBOS.getWorkflowStatus(id))?.status ?? null

async function cancelAll() {
  const open = await DBOS.listWorkflows({
    workflowName: 'convRemind',
    status: ['PENDING', 'ENQUEUED', 'DELAYED'],
  })
  if (open.length) await DBOS.cancelWorkflows(open.map((w) => w.workflowID))
}

/** The chat as the core stores it and as the fake service shows it. */
async function scene(
  messages: SeedMessage[],
  o: { clientName?: string | null; deal?: boolean } = {},
) {
  const conv = await seedChat(db, CHAT, messages, o)
  profi.chat.splice(
    0,
    profi.chat.length,
    ...messages.map(
      (m): ChatMessage => ({ ...chatMsg(m.id, m.side, m.text, m.at, CHAT), read: m.read ?? false }),
    ),
  )
  return conv
}

/** Our message `agoMs` ago, which the client did not answer. */
const quiet = (agoMs: number, o: { read?: boolean } = {}): SeedMessage[] => [
  {
    id: 'm-1',
    side: 'specialist',
    text: 'Анна, добрый день! Понимаю задачу, сделаем сайт для клиники.',
    at: ago(agoMs),
    read: o.read ?? false,
  },
]

const live = async () => {
  await setSetting(db, 'conv.v1_writes', false, 'system')
  await setSetting(db, 'outbound.messages', true, 'system')
}

async function useGateway(byRole: Record<string, unknown>, env: Record<string, string> = {}) {
  fake = await fakeGateway(db, byRole, env)
  deps.gateway = fake.gateway
}

beforeAll(async () => {
  await launchDbos(testDatabaseUrl())
}, 60000)

afterAll(async () => {
  await cancelAll()
  await shutdownDbos()
  await close()
})

/** The settings every test starts from; the reminder quiet hours are away from now, so a due reminder goes at once. */
async function baseSettings() {
  await setSetting(db, 'pipeline.conversations', true, 'system')
  const h = moscowHour(new Date())
  await setSetting(db, 'conv.reminder_quiet', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'system')
}

/** A second scene in one test: the tables are emptied, the settings put back. */
async function again() {
  await resetDb(db)
  await baseSettings()
}

beforeEach(async () => {
  await resetDb(db)
  sends = []
  reads = 0
  onRead = () => {}
  sendFails = null
  buttons = []
  booked = false
  profi.chat.length = 0
  profi.readChat = async () => {
    onRead(++reads)
    return { messages: [...profi.chat] }
  }
  profi.sendMessage = async (i) => {
    if (sendFails) throw sendFails
    sends.push({
      key: i.idempotency_key,
      text: i.text,
      expectLast: i.expect_last_message_id,
      chatId: i.chat_id,
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
    notifier,
    isBooked: async () => booked,
    minGapMs: 0,
    fallbackAfterMs: 1500,
    retryEveryMs: 300,
  }
  await useGateway({ reminder: SEQUENCE })
  setRemindDeps(deps)
  await baseSettings()
})

afterEach(cancelAll)

describe('a reminder in shadow', () => {
  it('FR-CONV-5: shadow never queues a message, the reminder is only recorded with its text', async () => {
    const conv = await scene(quiet(25 * HOUR))
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    const [r] = await rows()
    expect(r?.outcome).toBe('drafted')
    expect(r?.text).toBe(GOOD_TEXT)
    expect(r?.decision).toBe('draft')
    expect(r?.factIds).toEqual(['s-portrait', 'k-process-start'])
    expect(r?.modelCallIds).toHaveLength(1)
    expect(sends).toHaveLength(0)
    expect(await messageOutbox()).toHaveLength(0)
    expect(await countEvents(db, 'conv.reminder_drafted')).toBe(1)
    expect(await countEvents(db, 'conv.reminder_sent')).toBe(0)
    expect(buttons).toHaveLength(0)
  })

  it('FR-CONV-12: read and unread clients get different texts', async () => {
    const conv = await scene(quiet(25 * HOUR, { read: true }))
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    await again()
    const other = await scene(quiet(25 * HOUR, { read: false }))
    await startReminder(other.id, 'm-1')
    await until(done(1))
    const [read, unread] = (await fake.calls()).map((c) => c.stdin)
    expect(read).toContain('Клиент прочитал наше сообщение: да')
    expect(unread).toContain('Клиент прочитал наше сообщение: неизвестно')
  })

  it('FR-CONV-12: after 7 days in shadow the dormant client is only in the trace, with no task for Boris', async () => {
    const conv = await scene(quiet(8 * DAY), { deal: true })
    await startReminder(conv.id, 'm-1')
    await until(done(3))
    expect(await outcomes()).toEqual(['1=drafted', '2=drafted', 'dormant=dormant'])
    expect(await countEvents(db, 'conv.dormant')).toBe(1)
    expect(buttons).toHaveLength(0)
    expect(await db.select().from(task)).toHaveLength(0)
    expect(sends).toHaveLength(0)
    // The deal is not touched in shadow, and the ladder ends: nobody can say «Напоминать дальше».
    expect((await db.select().from(deal))[0]?.stage).toBe('bid_sent')
    await until(async () => (await statusOf(remindWorkflowId(conv.id, 'm-1'))) === 'SUCCESS')
  })
})

describe('a reminder after the switch', () => {
  it('FR-CONV-12: it goes once, with the key of its process and step, through the message outbox', async () => {
    await live()
    const conv = await scene(quiet(25 * HOUR))
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    expect(sends).toEqual([
      {
        key: `msg:conv-remind:${conv.id}:m-1:1`,
        text: GOOD_TEXT,
        expectLast: 'm-1',
        chatId: CHAT,
      },
    ])
    const [r] = await rows()
    expect(r?.outcome).toBe('sent')
    const queued = await messageOutbox()
    expect(queued).toHaveLength(1)
    expect(queued[0]?.state).toBe('confirmed')
    expect(await countEvents(db, 'conv.reminder_sent')).toBe(1)
    // A second start of the same process does not send again.
    await startReminder(conv.id, 'm-1')
    await sleep(500)
    expect(sends).toHaveLength(1)
  })

  it('FR-CONV-12: a reminder is not sent over a message the client wrote meanwhile', async () => {
    await live()
    const conv = await scene(quiet(25 * HOUR))
    // The first reading is the wake-up check; the client writes before the second one, right before sending.
    onRead = (n) => {
      if (n === 2) profi.chat.push(chatMsg('m-2', 'client', 'Да, давайте', ago(1000), CHAT))
    }
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    const [r] = await rows()
    expect(r?.outcome).toBe('stopped')
    expect(r?.decisionReason).toMatch(/клиент ответил/)
    expect(sends).toHaveLength(0)
    expect(await messageOutbox()).toHaveLength(0)
    await until(async () => (await statusOf(remindWorkflowId(conv.id, 'm-1'))) === 'SUCCESS')
  })

  it('FR-CONV-6: a reminder is not sent over a message our side wrote meanwhile', async () => {
    await live()
    const conv = await scene(quiet(25 * HOUR))
    onRead = (n) => {
      if (n === 2)
        profi.chat.push(chatMsg('m-2', 'specialist', 'Анна, я на связи', ago(1000), CHAT))
    }
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    expect((await rows())[0]?.outcome).toBe('stopped')
    expect((await rows())[0]?.decisionReason).toMatch(/наша сторона/)
    expect(sends).toHaveLength(0)
  })

  it('FR-CONV-6: the service refusing with CHAT_CHANGED sends nothing and ends the ladder', async () => {
    await live()
    sendFails = new ProfiError('CHAT_CHANGED', 'the chat has something new')
    const conv = await scene(quiet(25 * HOUR))
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    expect((await rows())[0]?.outcome).toBe('stopped')
    expect(sends).toHaveLength(0)
    await until(async () => (await statusOf(remindWorkflowId(conv.id, 'm-1'))) === 'SUCCESS')
  })

  it('FR-CONV-12: after 7 days the client is dormant and Boris gets one task', async () => {
    await live()
    const conv = await scene(quiet(8 * DAY), { deal: true })
    await startReminder(conv.id, 'm-1')
    await until(done(3))
    expect(await outcomes()).toEqual(['1=sent', '2=sent', 'dormant=dormant'])
    // The second reminder is not stopped by the first one standing in the chat after our message.
    expect(sends.map((s) => s.key)).toEqual([
      `msg:conv-remind:${conv.id}:m-1:1`,
      `msg:conv-remind:${conv.id}:m-1:2`,
    ])
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.text).toMatch(/молчит 7 дней/)
    expect(buttons[0]?.text).toMatch(/Анна/)
    expect(buttons[0]?.rows.flat().map((b) => b.text)).toEqual(['Закрыть', 'Напоминать дальше'])
    expect(buttons[0]?.text).not.toMatch(/[\u2013\u2014]/)
    const tasks = await db.select().from(task)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.kind).toBe('conv_dormant')
    expect(tasks[0]?.state).toBe('open')
    expect((await db.select().from(deal))[0]?.stage).toBe('dormant')
    expect(await countEvents(db, 'conv.dormant')).toBe(1)
    // Nothing more goes on its own: the process waits for Boris.
    await sleep(500)
    expect(sends).toHaveLength(2)
    expect(await statusOf(remindWorkflowId(conv.id, 'm-1'))).toBe('PENDING')
  })

  it('FR-CONV-12: «Напоминать дальше» brings the 10-day and the 30-day reminders, the last one friendly', async () => {
    await live()
    const conv = await scene(quiet(48 * DAY))
    await startReminder(conv.id, 'm-1')
    await until(async () => (await db.select().from(task)).length === 1)
    const t = (await db.select().from(task))[0]
    const press = {
      db,
      notifier: { sendText: async () => ({ messageId: 1 }) },
      decideDormant,
    }
    const answer = await onConvPress(press, { taskId: t?.id ?? '', action: 'remind' })
    expect(answer).toMatch(/10 суток/)
    await until(done(5))
    expect(await outcomes()).toEqual(['1=sent', '2=sent', 'dormant=dormant', '3=sent', '4=sent'])
    expect(sends).toHaveLength(4)
    const inputs = (await fake.calls()).map((c) => c.stdin)
    expect(inputs[2]).toContain('По счёту: 3 из 4')
    expect(inputs[2]).toContain('Тон: обычный')
    expect(inputs[3]).toContain('По счёту: 4 из 4')
    expect(inputs[3]).toContain('Тон: дружеский')
    expect((await db.select().from(task))[0]?.resolution).toBe('remind')
    await until(async () => (await statusOf(remindWorkflowId(conv.id, 'm-1'))) === 'SUCCESS')
  })

  it('FR-CONV-12: «Закрыть» on the dormant task closes the conversation and ends the ladder', async () => {
    await live()
    const conv = await scene(quiet(8 * DAY), { deal: true })
    await startReminder(conv.id, 'm-1')
    await until(async () => (await db.select().from(task)).length === 1)
    const t = (await db.select().from(task))[0]
    const press = {
      db,
      notifier: { sendText: async () => ({ messageId: 1 }) },
      decideDormant,
    }
    await onConvPress(press, { taskId: t?.id ?? '', action: 'close' })
    expect((await db.select().from(conversation))[0]?.closedAt).not.toBeNull()
    expect((await db.select().from(task))[0]?.state).toBe('resolved')
    expect((await db.select().from(deal))[0]?.stage).toBe('lost')
    await until(async () => (await statusOf(remindWorkflowId(conv.id, 'm-1'))) === 'SUCCESS')
    expect(sends).toHaveLength(2)
  })

  it('FR-CONV-12: an answer of Boris for a process that is gone is harmless, and the task answers «уже сделано»', async () => {
    await live()
    await decideDormant('conv-remind:no-such-conversation:m-1:dormant', 'remind')
    const press = { db, notifier: { sendText: async () => ({ messageId: 1 }) }, decideDormant }
    expect(await onConvPress(press, { taskId: newEventId(), action: 'remind' })).toBe(
      'Это уже сделано.',
    )
  })

  it('FR-CONV-12: no model text for 3 hours past the time means the ready text of old Sara', async () => {
    await live()
    await useGateway({ reminder: GOOD }, { FAKE_CLAUDE_MODE: 'exit1' })
    const conv = await scene(quiet(25 * HOUR))
    const startedAt = Date.now()
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    // Short in the test: the model is asked again and again until the time is over, then the ready text goes.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1400)
    expect((await fake.calls()).length).toBeGreaterThan(2)
    expect(sends.map((s) => s.text)).toEqual([reminderFallback('Анна', 'check_in')])
    const [r] = await rows()
    expect(r?.outcome).toBe('sent')
    expect(r?.checks).toMatchObject({ fallback: true })
  })

  it('FR-CONV-12: a text that keeps failing the checks also ends in the ready text', async () => {
    await live()
    await useGateway({ reminder: { ...GOOD, text: '[имя 1], здравствуйте \u2014 как дела?' } })
    const conv = await scene(quiet(25 * HOUR))
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    expect(sends.map((s) => s.text)).toEqual([reminderFallback('Анна', 'check_in')])
  })

  it('FR-OPS-1: with the «Пишет клиентам» pause on nothing is sent and the step is skipped', async () => {
    await live()
    await setSetting(db, 'outbound.messages', false, 'system')
    const conv = await scene(quiet(25 * HOUR))
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    const [r] = await rows()
    expect(r?.outcome).toBe('skipped')
    expect(r?.decisionReason).toMatch(/пауза/)
    expect(sends).toHaveLength(0)
    expect(await messageOutbox()).toHaveLength(0)
    expect((await fake.calls()).length).toBe(0)
  })

  it('FR-OPS-1: with the account paused nothing is sent', async () => {
    await live()
    await scene(quiet(25 * HOUR))
    await db.update(account).set({ paused: true }).where(eq(account.id, ACC))
    const conv = (await db.select().from(conversation))[0]
    await startReminder(conv?.id ?? '', 'm-1')
    await until(done(1))
    expect((await rows())[0]?.outcome).toBe('skipped')
    expect(sends).toHaveLength(0)
  })
})

describe('when a reminder must not go', () => {
  const none = async (why: RegExp, setup: (convId: string) => Promise<void>) => {
    await live()
    const conv = await scene(quiet(25 * HOUR))
    await setup(conv.id)
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    const [r] = await rows()
    expect(r?.outcome).toBe('stopped')
    expect(r?.decisionReason).toMatch(why)
    expect(sends).toHaveLength(0)
    expect(await messageOutbox()).toHaveLength(0)
    expect(await countEvents(db, 'conv.reminder_sent')).toBe(0)
    expect((await fake.calls()).length).toBe(0)
    await until(async () => (await statusOf(remindWorkflowId(conv.id, 'm-1'))) === 'SUCCESS')
  }

  it('FR-CONV-12: no reminder goes if the client answered', async () => {
    await none(/клиент ответил/, async () => {
      profi.chat.push(chatMsg('m-2', 'client', 'Добрый день, посмотрю', ago(HOUR), CHAT))
    })
  })

  it('FR-CONV-1: a client message the reminder meets is left unstored, so the check of the chats still starts its turn', async () => {
    await none(/клиент ответил/, async () => {
      profi.chat.push(chatMsg('m-2', 'client', 'Добрый день, посмотрю', ago(HOUR), CHAT))
    })
    // The reading only looks: the message reaches the conversation through its own event or the 10-minute check.
    expect((await db.select().from(chatMessage)).map((m) => m.platformMessageId)).toEqual(['m-1'])
  })

  it('FR-CONV-12: a closed conversation gets none', async () => {
    await none(/закрыт/, async (id) => {
      await db
        .update(conversation)
        .set({ closedAt: new Date().toISOString() })
        .where(eq(conversation.id, id))
    })
  })

  it('FR-CONV-12: a client Boris leads gets none, taken or written to by him', async () => {
    await none(/Борис/, async (id) => {
      await db
        .update(conversation)
        .set({ owner: 'boris', ownerReason: 'take' })
        .where(eq(conversation.id, id))
    })
    await again()
    await none(/Борис/, async (id) => {
      await db
        .update(conversation)
        .set({ owner: 'boris', ownerReason: 'wrote' })
        .where(eq(conversation.id, id))
    })
  })

  it('FR-CONV-12: a conversation with a booked meeting gets none (M6)', async () => {
    await none(/встреч/, async () => {
      booked = true
    })
  })

  it('FR-CONV-12: a conversation with a running turn gets none now', async () => {
    await live()
    const conv = await scene(quiet(25 * HOUR))
    await db.insert(convTurn).values({
      id: `conv-turn:${conv.id}:x`,
      conversationId: conv.id,
      anchorMessageId: 'm-1',
      state: 'waiting',
    })
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    const [r] = await rows()
    expect(r?.outcome).toBe('skipped')
    expect(r?.decisionReason).toMatch(/ход/)
    expect(sends).toHaveLength(0)
  })

  it('FR-CONV-12: a message of our side after the anchor ends the ladder', async () => {
    await none(/наша сторона/, async () => {
      profi.chat.push(chatMsg('m-2', 'specialist', 'Анна, я на связи', ago(HOUR), CHAT))
    })
  })

  it('FR-CONV-12: a message of an unclear author ends the ladder', async () => {
    await none(/неясен/, async () => {
      profi.chat.push(chatMsg('m-2', 'unknown', '???', ago(HOUR), CHAT))
    })
  })

  it('FR-CONV-12: while conversations or reminders are off nothing starts', async () => {
    await live()
    const conv = await scene(quiet(25 * HOUR))
    await setSetting(db, 'pipeline.conversations', false, 'system')
    await startReminder(conv.id, 'm-1')
    await setSetting(db, 'pipeline.conversations', true, 'system')
    await setSetting(db, 'conv.reminders', false, 'system')
    await startReminder(conv.id, 'm-1')
    await sleep(500)
    expect(await statusOf(remindWorkflowId(conv.id, 'm-1'))).toBeNull()
    expect(await rows()).toHaveLength(0)
  })

  it('FR-CONV-12: a reminder that wakes after the switches went off does nothing', async () => {
    await live()
    const conv = await scene(quiet(25 * HOUR))
    for (const [key, why] of [
      ['pipeline.conversations', /разговоры выключены/],
      ['conv.reminders', /напоминания выключены/],
    ] as const) {
      await setSetting(db, 'pipeline.conversations', true, 'system')
      await setSetting(db, 'conv.reminders', true, 'system')
      await setSetting(db, key, false, 'system')
      const g = await checkGround(deps, conv.id, 'm-1', { dormant: false })
      expect(g.go).toBe(false)
      expect(g.go ? '' : g.why).toMatch(why)
      expect(g.go ? false : g.end).toBe(true)
    }
    expect(sends).toHaveLength(0)
  })

  it('FR-CONV-12: an unreadable chat sends nothing and skips the step', async () => {
    await live()
    const conv = await scene(quiet(25 * HOUR))
    profi.readChat = async () => {
      throw new Error('the chat page is not open')
    }
    await startReminder(conv.id, 'm-1')
    await until(done(1))
    expect((await rows())[0]?.outcome).toBe('skipped')
    expect(sends).toHaveLength(0)
    expect((await fake.calls()).length).toBe(0)
  })
})

describe('the time of a reminder', () => {
  it('FR-CONV-12: a reminder due at night waits until 9:00 Moscow, and nothing goes meanwhile', async () => {
    await live()
    // The quiet hours cover now: the day is the night of this test.
    const h = moscowHour(new Date())
    const quietNow = { from: (h + 23) % 24, to: (h + 2) % 24 }
    await setSetting(db, 'conv.reminder_quiet', quietNow, 'system')
    const conv = await scene(quiet(25 * HOUR))
    await startReminder(conv.id, 'm-1')
    const wf = remindWorkflowId(conv.id, 'm-1')
    await until(async () =>
      ((await DBOS.listWorkflowSteps(wf)) ?? []).some((s) => s.name === 'plan-0'),
    )
    const planned = ((await DBOS.listWorkflowSteps(wf)) ?? []).find((s) => s.name === 'plan-0')
    const at = String((planned?.output as { at?: string } | undefined)?.at)
    expect(at).toBe(moscowHoursEnd(new Date(), quietNow)?.toISOString())
    expect(new Date(at).getTime()).toBeGreaterThan(Date.now())
    await sleep(600)
    expect(sends).toHaveLength(0)
    expect(await rows()).toHaveLength(0)
    expect(await statusOf(wf)).toBe('PENDING')
  })

  it('FR-CONV-12: a reminder not yet due waits and leaves no trace', async () => {
    await live()
    const conv = await scene(quiet(2 * HOUR))
    await startReminder(conv.id, 'm-1')
    const wf = remindWorkflowId(conv.id, 'm-1')
    await sleep(500)
    expect(await statusOf(wf)).toBe('PENDING')
    expect(await rows()).toHaveLength(0)
    expect(sends).toHaveLength(0)
  })
})
