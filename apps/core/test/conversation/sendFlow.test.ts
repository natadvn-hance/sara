import { DBOS } from '@dbos-inc/dbos-sdk'
import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendWorkflowId, setSendDeps, startSendJob } from '../../src/conversation/sendFlow'
import { prepareJob, queueJob } from '../../src/conversation/sendJob'
import { SEND_TEXTS, STALE_DRAFT } from '../../src/conversation/sendTexts'
import { convTurn, outbox, task } from '../../src/db/schema'
import { ProfiError } from '../../src/profi/client'
import { setSetting } from '../../src/settings/store'
import { launchDbos, shutdownDbos } from '../../src/workflows/dbos'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb, testDatabaseUrl } from '../helpers/db'
import { seedChat } from '../helpers/reminders'

const { db, close } = openTestDb()
const CHAT = '95147898'
const HOUR = 3600_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 })

const profi = stubProfi([])
let told: string[]
let sends: { key: string; text: string; expectLast: string | null }[]
let sendDelay: number
let sendError: ProfiError | null
let ground: Parameters<typeof setSendDeps>[0]['ground']

async function until(cond: () => Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await sleep(50)
  }
  throw new Error('condition not met in time')
}
const status = async (key: string) =>
  (await DBOS.getWorkflowStatus(sendWorkflowId(key)))?.status ?? null
const finished = (key: string) => async () => (await status(key)) === 'SUCCESS'

beforeAll(async () => {
  await launchDbos(testDatabaseUrl())
}, 60000)

afterAll(async () => {
  await shutdownDbos()
  await close()
})

beforeEach(async () => {
  await resetDb(db)
  told = []
  sends = []
  sendDelay = 0
  sendError = null
  ground = undefined
  profi.chat.splice(0, profi.chat.length)
  profi.sendMessage = async (i) => {
    if (sendDelay) await sleep(sendDelay)
    if (sendError) throw sendError
    sends.push({
      key: i.idempotency_key,
      text: i.text,
      expectLast: i.expect_last_message_id,
    })
    const id = `s-${sends.length}`
    profi.chat.push(chatMsg(id, 'specialist', i.text, new Date().toISOString(), CHAT))
    return { found_on_page: true, platform_message_id: id }
  }
  setSendDeps({
    db,
    profi,
    notifier: {
      sendText: async (text) => {
        told.push(text)
        return { messageId: 1 }
      },
    },
    ground: (c, a) => (ground ? ground(c, a) : Promise.reject(new Error('no ground'))),
  })
  await setSetting(db, 'conv.v1_writes', false, 'system')
  await setSetting(db, 'outbound.messages', true, 'system')
})

async function scene() {
  const msgs = [
    {
      id: 'm-1',
      side: 'specialist' as const,
      text: 'Добрый день',
      at: new Date(Date.now() - HOUR).toISOString(),
    },
    { id: 'm-2', side: 'client' as const, text: 'Как начнём?', at: new Date().toISOString() },
  ]
  const conv = await seedChat(db, CHAT, msgs)
  for (const m of msgs) profi.chat.push(chatMsg(m.id, m.side, m.text, m.at, CHAT))
  return conv
}

const job = async (conversationId: string, o: Parameters<typeof prepareJob>[4] = {}) => {
  const j = await prepareJob({ db }, conversationId, 'Анна, добрый день!', 'boris', {
    key: `say:tg:${newEventId()}`,
    ...o,
  })
  if (!j) throw new Error('no conversation')
  return j
}

describe('the send of a text as its own process', () => {
  it('FR-CONV-9: the press is answered at once, a slow delivery runs on, and Boris is told in a new message', async () => {
    const conv = await scene()
    sendDelay = 1500
    const j = await job(conv.id)
    const started = Date.now()
    expect(await startSendJob(j)).toBe(SEND_TEXTS.sending)
    // The send takes 1.5 s in the service: the answer did not wait for it.
    expect(Date.now() - started).toBeLessThan(900)
    expect(sends).toHaveLength(0)
    await until(finished(j.key))
    expect(sends).toEqual([{ key: `msg:${j.key}`, text: 'Анна, добрый день!', expectLast: 'm-2' }])
    expect(told).toHaveLength(1)
    expect(told[0]).toMatch(/^✅ .*Анна.*: Отправила клиенту\.$/)
    const [row] = await db.select().from(outbox)
    expect(row?.state).toBe('confirmed')
  })

  it('FR-CONV-9: the same press delivered twice is one process and one message', async () => {
    const conv = await scene()
    sendDelay = 400
    const j = await job(conv.id)
    await startSendJob(j)
    await startSendJob(j)
    await until(finished(j.key))
    await sleep(300)
    expect(sends).toHaveLength(1)
    expect(await db.select().from(outbox)).toHaveLength(1)
    expect(told).toHaveLength(1)
  })

  it('NFR-REL-3: a text queued before a restart is delivered once by the process that finds it, not stranded', async () => {
    const conv = await scene()
    const j = await job(conv.id)
    // The press queued the message and the core went down before the delivery.
    expect(await queueJob(db, j, 'm-2')).not.toBeNull()
    expect(sends).toHaveLength(0)
    await startSendJob(j)
    await until(finished(j.key))
    expect(sends.map((s) => s.key)).toEqual([`msg:${j.key}`])
    expect(await db.select().from(outbox)).toHaveLength(1)
    expect((await db.select().from(outbox))[0]?.state).toBe('confirmed')
  })

  it('FR-CONV-6: a chat that moved on makes the draft stale, and Boris is told', async () => {
    const conv = await scene()
    const taskId = newEventId()
    await db.insert(task).values({
      id: taskId,
      kind: 'conv_draft',
      entityKind: 'conv_turn',
      entityId: 't-x',
      state: 'resolved',
      resolution: 'send',
    })
    sendError = new ProfiError('CHAT_CHANGED', 'moved on')
    const j = await job(conv.id, { after: { kind: 'draft', taskId } })
    await startSendJob(j)
    await until(finished(j.key))
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    expect(t?.resolution).toBe('stale')
    expect(told[0]).toContain(STALE_DRAFT)
    expect(told[0]).toMatch(/^⚠️/)
  })

  it('FR-CONV-12: a job with a time to wait for goes only after it', async () => {
    const conv = await scene()
    const j = await job(conv.id, { notBefore: new Date(Date.now() + 1500).toISOString() })
    await startSendJob(j)
    await sleep(700)
    expect(sends).toHaveLength(0)
    await until(finished(j.key))
    expect(sends).toHaveLength(1)
  })

  it('FR-OPS-1: a refusal of the outbox (a pause) is told as «не отправляю», nothing goes', async () => {
    const conv = await scene()
    await setSetting(db, 'outbound.messages', false, 'system')
    const j = await prepareJob({ db }, conv.id, 'Анна, добрый день!', 'sara', {
      key: `say:${newEventId()}`,
    })
    await startSendJob(j as NonNullable<typeof j>)
    await until(finished((j as NonNullable<typeof j>).key))
    expect(sends).toHaveLength(0)
    expect(told[0]).toContain(SEND_TEXTS.notNow)
  })

  it('FR-CONV-12: the reread of a reminder that says the client wrote closes the card, nothing goes', async () => {
    const conv = await scene()
    const rowId = `conv-remind:${conv.id}:m-1:1`
    await db.insert(convTurn).values({
      id: rowId,
      conversationId: conv.id,
      kind: 'reminder',
      anchorMessageId: 'm-1',
      state: 'finished',
      outcome: 'sending',
      text: 'Анна, здравствуйте!',
    })
    const taskId = newEventId()
    await db.insert(task).values({
      id: taskId,
      kind: 'conv_draft',
      entityKind: 'conv_turn',
      entityId: rowId,
      state: 'resolved',
      resolution: 'send',
    })
    ground = async () => ({ go: false, end: true, why: 'клиент ответил' })
    const j = await job(conv.id, {
      after: { kind: 'reminder', rowId, taskId, how: 'send' },
      ground: { anchor: 'm-1' },
    })
    await startSendJob(j)
    await until(finished(j.key))
    expect(sends).toHaveLength(0)
    expect((await db.select().from(convTurn).where(eq(convTurn.id, rowId)))[0]).toMatchObject({
      outcome: 'stopped',
      decisionReason: 'клиент ответил',
    })
    expect(told[0]).toContain('клиент ответил')
  })

  it('FR-OPS-1: the reread that says «not now» opens the card again for a later press', async () => {
    const conv = await scene()
    const rowId = `conv-remind:${conv.id}:m-1:1`
    await db.insert(convTurn).values({
      id: rowId,
      conversationId: conv.id,
      kind: 'reminder',
      anchorMessageId: 'm-1',
      state: 'finished',
      outcome: 'sending',
      text: 'Анна, здравствуйте!',
    })
    const taskId = newEventId()
    await db.insert(task).values({
      id: taskId,
      kind: 'conv_draft',
      entityKind: 'conv_turn',
      entityId: rowId,
      state: 'resolved',
      resolution: 'send',
    })
    ground = async () => ({ go: false, end: false, why: 'пауза «Пишет клиентам»' })
    const j = await job(conv.id, {
      after: { kind: 'reminder', rowId, taskId, how: 'send' },
      ground: { anchor: 'm-1' },
    })
    await startSendJob(j)
    await until(finished(j.key))
    expect(sends).toHaveLength(0)
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    expect(t).toMatchObject({ state: 'open', resolution: null })
    expect((await db.select().from(convTurn).where(eq(convTurn.id, rowId)))[0]?.outcome).toBe(
      'carded',
    )
    expect(told[0]).toContain('пауза «Пишет клиентам»')
  })
})
