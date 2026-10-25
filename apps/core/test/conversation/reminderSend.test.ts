import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { queueMessage } from '../../src/conversation/outbox'
import { type Planned, type RemindDeps, sendStep } from '../../src/conversation/reminderSteps'
import { account, convTurn, outbox } from '../../src/db/schema'
import type { ProfiClient } from '../../src/profi/client'
import { setSetting } from '../../src/settings/store'
import { chatMsg, fakeMind, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { ACC, seedChat } from '../helpers/reminders'

const { db, close } = openTestDb()
afterAll(close)

const CHAT = '95147898'
const TEXT = 'Анна, здравствуйте! Как у вас дела с сайтом для клиники?'
const PLAN: Planned = { at: new Date().toISOString(), step: 1, tone: 'check_in' }
const profi = stubProfi([])
let sends: string[]
let deps: RemindDeps

beforeEach(async () => {
  await resetDb(db)
  sends = []
  profi.chat.splice(0, profi.chat.length)
  profi.sendMessage = async (i) => {
    sends.push(i.idempotency_key)
    return { found_on_page: true, platform_message_id: 's-1' }
  }
  deps = {
    db,
    profi: profi as ProfiClient,
    gateway: null as unknown as RemindDeps['gateway'],
    mind: fakeMind(),
    notifier: { sendButtons: async () => ({ messageId: 1 }) },
  }
  await setSetting(db, 'pipeline.conversations', true, 'system')
  await setSetting(db, 'conv.v1_writes', false, 'system')
  await setSetting(db, 'outbound.messages', true, 'system')
})

/** A reminder that the first run queued before the process was killed: its outbox row stands, the step must be redone. */
async function queued() {
  const at = new Date(Date.now() - 25 * 3600_000).toISOString()
  const conv = await seedChat(db, CHAT, [
    { id: 'm-1', side: 'specialist', text: 'Добрый день', at },
  ])
  profi.chat.push(chatMsg('m-1', 'specialist', 'Добрый день', at, CHAT))
  const rowId = `conv-remind:${conv.id}:m-1:1`
  await db.insert(convTurn).values({
    id: rowId,
    conversationId: conv.id,
    kind: 'reminder',
    anchorMessageId: 'm-1',
    state: 'waiting',
    text: TEXT,
  })
  const outboxId = await db.transaction((tx) =>
    queueMessage(tx, {
      key: rowId,
      accountId: ACC,
      chatId: CHAT,
      text: TEXT,
      author: 'sara',
      expectLast: 'm-1',
    }),
  )
  expect(outboxId).not.toBeNull()
  return { conv, rowId }
}

const row = async (id: string) => (await db.select().from(convTurn).where(eq(convTurn.id, id)))[0]
const message = async () => (await db.select().from(outbox)).filter((o) => o.kind === 'message')

describe('a reminder queued before a restart', () => {
  it('FR-CONV-12: with nothing changed, the recovered step sends it once with the same key', async () => {
    const { conv, rowId } = await queued()
    const r = await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)
    expect(r).toEqual({ outcome: 'sent', end: false })
    expect(sends).toEqual([`msg:${rowId}`])
    expect((await message())[0]?.state).toBe('confirmed')
  })

  it('FR-OPS-1: the «Пишет клиентам» pause that came after the queueing keeps the recovered step from sending', async () => {
    const { conv, rowId } = await queued()
    await setSetting(db, 'outbound.messages', false, 'system')
    const r = await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)
    expect(r).toEqual({ outcome: 'skipped', end: false })
    expect(sends).toHaveLength(0)
    expect((await message())[0]?.state).toBe('queued')
    expect(await row(rowId)).toMatchObject({ outcome: 'skipped', state: 'finished' })
  })

  it('FR-CONV-5: the shadow switched back on keeps the recovered step from sending', async () => {
    const { conv, rowId } = await queued()
    await setSetting(db, 'conv.v1_writes', true, 'system')
    const r = await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)
    expect(r.outcome).toBe('skipped')
    expect(sends).toHaveLength(0)
    expect((await message())[0]?.state).toBe('queued')
  })

  it('FR-OPS-1: the account paused after the queueing keeps the recovered step from sending', async () => {
    const { conv, rowId } = await queued()
    await db.update(account).set({ paused: true }).where(eq(account.id, ACC))
    const r = await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)
    expect(r.outcome).toBe('skipped')
    expect(sends).toHaveLength(0)
    expect((await message())[0]?.state).toBe('queued')
    expect((await row(rowId))?.decisionReason).toMatch(/аккаунт/)
  })

  it('FR-OPS-1: an account that is logged out or banned does not get the recovered send either', async () => {
    for (const state of ['dead', 'banned']) {
      await resetDb(db)
      await setSetting(db, 'pipeline.conversations', true, 'system')
      await setSetting(db, 'conv.v1_writes', false, 'system')
      await setSetting(db, 'outbound.messages', true, 'system')
      const { conv, rowId } = await queued()
      await db.update(account).set({ loginState: state }).where(eq(account.id, ACC))
      expect((await sendStep(deps, rowId, conv.id, 'm-1', PLAN, TEXT)).outcome).toBe('skipped')
    }
    expect(sends).toHaveLength(0)
  })
})
