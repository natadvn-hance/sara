import { DBOS } from '@dbos-inc/dbos-sdk'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { moscowDay } from '../../src/conversation/pingScenario'
import { catchUpLadders, remindWorkflowId, setRemindDeps } from '../../src/conversation/reminders'
import { moscowHour, moscowHoursEnd } from '../../src/conversation/time'
import type { ConversationRow } from '../../src/conversation/types'
import { conversation } from '../../src/db/schema'
import { setSetting } from '../../src/settings/store'
import { launchDbos, shutdownDbos } from '../../src/workflows/dbos'
import { fakeMind, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb, testDatabaseUrl } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'
import { type SeedMessage, seedChat } from '../helpers/reminders'

// 12.11.2026: a client Boris wrote to himself got no ladder at all. After the deploy the silent ones must get theirs
// without waiting for a new message, and their steps already due must not come as a flood of cards.

vi.setConfig({ testTimeout: 30_000 })

const { db, close } = openTestDb()
const HOUR = 3600_000
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const borisSaid = (id: string, ms: number): SeedMessage => ({
  id,
  side: 'specialist',
  text: 'Анна, добрый день! Это Борис, посмотрел вашу задачу.',
  at: ago(ms),
  author: 'boris',
  basis: 'after_cutover',
})

const statusOf = async (id: string) => (await DBOS.getWorkflowStatus(id))?.status ?? null

async function owner(conv: ConversationRow, set: Partial<typeof conversation.$inferInsert>) {
  await db.update(conversation).set(set).where(eq(conversation.id, conv.id))
}

/** A chat where Boris wrote himself `ms` ago and the client is silent since; the owner rule made her his. */
async function hisSilentClient(chat: string, ms = 3 * DAY) {
  const conv = await seedChat(db, chat, [borisSaid(`m-${chat}`, ms)])
  await owner(conv, { owner: 'boris', ownerReason: 'wrote' })
  return conv
}

/** The ladders of these conversations, whatever their state (the DBOS records outlive the tables of a test). */
async function laddersOf(convs: ConversationRow[]) {
  const all = await Promise.all(
    convs.map((c) => DBOS.listWorkflows({ workflow_id_prefix: `conv-remind:${c.id}:` })),
  )
  return all.flat()
}

/** When the first step of a ladder is planned (its plan-0 step). */
async function firstAt(wf: string): Promise<Date> {
  for (let i = 0; i < 100; i++) {
    const step = ((await DBOS.listWorkflowSteps(wf)) ?? []).find((s) => s.name === 'plan-0')
    if (step?.output) return new Date((step.output as { at: string }).at)
    await sleep(100)
  }
  throw new Error(`no plan of ${wf}`)
}

async function cancelAll() {
  const open = await DBOS.listWorkflows({
    workflowName: 'convRemind',
    status: ['PENDING', 'ENQUEUED', 'DELAYED'],
  })
  if (open.length) await DBOS.cancelWorkflows(open.map((w) => w.workflowID))
}

beforeAll(async () => {
  await launchDbos(testDatabaseUrl())
}, 60000)

afterAll(async () => {
  await cancelAll()
  await shutdownDbos()
  await close()
})

beforeEach(async () => {
  await resetDb(db)
  setRemindDeps({
    db,
    profi: stubProfi([]),
    gateway: (await fakeGateway(db, {})).gateway,
    mind: fakeMind(),
    notifier: { sendButtons: async () => ({ messageId: 1 }) },
  })
  await setSetting(db, 'pipeline.conversations', true, 'system')
  // The quiet hours away from now: a step due now is planned for now.
  const h = moscowHour(new Date())
  await setSetting(db, 'conv.reminder_quiet', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'system')
})

afterEach(cancelAll)

describe('the catch-up of ladders', () => {
  it('FR-CONV-12: a silent client Boris wrote to gets the ladder of his message without a new message, once', async () => {
    const conv = await hisSilentClient('95100001')
    expect(await catchUpLadders()).toBe(1)
    expect(await statusOf(remindWorkflowId(conv.id, 'm-95100001'))).toBe('PENDING')
    // The pass runs again every ten minutes: what has its ladder is left alone.
    expect(await catchUpLadders()).toBe(0)
    const all = await DBOS.listWorkflows({ workflow_id_prefix: `conv-remind:${conv.id}:` })
    expect(all).toHaveLength(1)
  })

  it('FR-CONV-12: a client Boris took, a closed one, Sara’s own and one who answered get nothing from it', async () => {
    const taken = await hisSilentClient('95100002')
    await owner(taken, { ownerReason: 'take' })
    const closed = await hisSilentClient('95100003')
    await owner(closed, { closedAt: new Date().toISOString() })
    // Sara's own clients have their ladders from the reading of the chat; the catch-up is for Boris's alone.
    const saras = await seedChat(db, '95100004', [
      { id: 'm-95100004', side: 'specialist', text: 'Анна, добрый день!', at: ago(3 * DAY) },
    ])
    const answered = await seedChat(db, '95100005', [
      borisSaid('m-95100005', 3 * DAY),
      { id: 'm-95100005-2', side: 'client', text: 'Спасибо, подумаю', at: ago(2 * DAY) },
    ])
    await owner(answered, { owner: 'boris', ownerReason: 'wrote' })
    expect(await catchUpLadders()).toBe(0)
    expect(await laddersOf([taken, closed, saras, answered])).toHaveLength(0)
  })

  it('FR-CONV-12: a silence older than two weeks is history, the catch-up leaves it', async () => {
    await hisSilentClient('95100006', 15 * DAY)
    expect(await catchUpLadders()).toBe(0)
  })

  it('FR-CONV-12: steps already due come one at a time: an hour apart, at most conv.cards_per_day a day, never in the quiet hours', async () => {
    await setSetting(db, 'conv.cards_per_day', 2, 'system')
    const convs = [
      await hisSilentClient('95100011', 4 * DAY),
      await hisSilentClient('95100012', 3 * DAY),
      await hisSilentClient('95100013', 2 * DAY),
    ]
    expect(await catchUpLadders()).toBe(3)
    const times = (
      await Promise.all(convs.map((c) => firstAt(remindWorkflowId(c.id, `m-${c.chatId}`))))
    ).sort((a, b) => a.getTime() - b.getTime())
    // The first is due now.
    expect(Math.abs((times[0]?.getTime() ?? 0) - Date.now())).toBeLessThan(5 * 60_000)
    for (let i = 1; i < times.length; i++)
      expect((times[i]?.getTime() ?? 0) - (times[i - 1]?.getTime() ?? 0)).toBeGreaterThanOrEqual(
        HOUR - 1000,
      )
    const perDay = new Map<string, number>()
    for (const t of times) perDay.set(moscowDay(t), (perDay.get(moscowDay(t)) ?? 0) + 1)
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(2)
    const quiet = { from: (moscowHour(new Date()) + 2) % 24, to: (moscowHour(new Date()) + 3) % 24 }
    for (const t of times) expect(moscowHoursEnd(t, quiet)).toBeNull()
  })

  it('FR-CONV-12: while conversations or reminders are off the catch-up starts nothing', async () => {
    const conv = await hisSilentClient('95100021')
    await setSetting(db, 'conv.reminders', false, 'system')
    expect(await catchUpLadders()).toBe(0)
    await setSetting(db, 'conv.reminders', true, 'system')
    await setSetting(db, 'pipeline.conversations', false, 'system')
    expect(await catchUpLadders()).toBe(0)
    expect(await laddersOf([conv])).toHaveLength(0)
  })
})
