import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversation, event, task } from '../../src/db/schema'
import { createRedactor } from '../../src/gateway/redact'
import { periodCounts, periodDays } from '../../src/secretary/counts'
import { runTool, type SecretaryDeps, type TurnContext } from '../../src/secretary/tools'
import { ROOT } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))
afterEach(() => vi.useRealTimers())

// 31.10.2026, 17:00 in Moscow.
const now = new Date('2026-10-31T14:00:00Z')
const TODAY_MORNING = '2026-10-31T00:30:00+03:00'
const TODAY_AFTERNOON = '2026-10-31T13:00:00+03:00'
const YESTERDAY_LATE = '2026-10-30T23:59:00+03:00'
const CONV = '0199a000-0000-7000-8000-0000000000c1'
const TEST_CONV = '0199a000-0000-7000-8000-0000000000c2'
const TASK_REAL = '0199a000-0000-7000-8000-0000000000a1'
const TASK_TEST = '0199a000-0000-7000-8000-0000000000a2'

let n = 0
const ev = (
  type: string,
  entityId: string,
  at: string,
  payload: Record<string, unknown> = {},
  entityKind = 'lead',
) =>
  db.insert(event).values({
    id: `0199b000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
    type,
    v: 1,
    entityKind,
    entityId,
    actor: 'sara',
    occurredAt: new Date(at).toISOString(),
    correlationId: '0199b000-0000-7000-8000-00000000ffff',
    payload,
  })

async function seed() {
  await db.insert(conversation).values([
    { id: CONV, accountId: 'a', chatId: '1', orderId: '95000001' },
    { id: TEST_CONV, accountId: 'a', chatId: '99000000001', orderId: '99000000001' },
  ])
  await db.insert(task).values([
    {
      id: TASK_REAL,
      kind: 'lead_decision',
      entityKind: 'lead',
      entityId: '95000001',
      state: 'open',
    },
    {
      id: TASK_TEST,
      kind: 'lead_decision',
      entityKind: 'lead',
      entityId: '99000000001',
      state: 'open',
    },
  ])
  // Today: 3 real orders found, one of them stopped by the screen; one test order; one found yesterday late.
  for (const id of ['95000001', '95000002', '95000003', '99000000001'])
    await ev('lead.found', id, TODAY_MORNING)
  await ev('lead.found', '95000009', YESTERDAY_LATE)
  await ev('lead.screened', '95000003', TODAY_MORNING, { stops: true, out: true })
  await ev('lead.screened', '95000002', TODAY_MORNING, { stops: true, out: false })
  await ev('lead.scored', '95000001', TODAY_AFTERNOON)
  await ev('lead.scored', '95000002', TODAY_AFTERNOON)
  await ev('lead.scored', '99000000001', TODAY_AFTERNOON)
  await ev('card.sent', TASK_REAL, TODAY_AFTERNOON, {}, 'task')
  await ev('card.sent', TASK_REAL, TODAY_AFTERNOON, {}, 'task') // a card sent again is still one card
  await ev('card.sent', TASK_TEST, TODAY_AFTERNOON, {}, 'task')
  await ev('bid.sent', '95000001', TODAY_AFTERNOON, { spent_rub: 300 })
  await ev('spend.recorded', '95000001', TODAY_AFTERNOON, { amount_rub: 300 })
  await ev('bid.sent', '99000000001', TODAY_AFTERNOON, { spent_rub: 300 })
  await ev('bid.failed', '95000002', TODAY_AFTERNOON)
  await ev('conv.message_heard', CONV, TODAY_AFTERNOON, { author: 'client' }, 'conversation')
  await ev('conv.message_heard', CONV, TODAY_AFTERNOON, { author: 'client' }, 'conversation')
  await ev('conv.message_heard', CONV, TODAY_AFTERNOON, { author: 'sara' }, 'conversation')
  await ev('conv.message_heard', TEST_CONV, TODAY_AFTERNOON, { author: 'client' }, 'conversation')
  await ev('conv.turn_sent', 't1', TODAY_AFTERNOON, { conversation_id: CONV }, 'conv_turn')
  await ev('conv.turn_sent', 't2', TODAY_AFTERNOON, { conversation_id: TEST_CONV }, 'conv_turn')
}

describe('the Secretary counts a period from the journal', () => {
  it('FR-NOTIF-4: «сегодня» counts the Moscow day so far, with no test orders', async () => {
    await seed()
    expect(await periodCounts(db, { period: 'today' }, now)).toEqual({
      from: '2026-10-31',
      to: '2026-10-31',
      untilNow: true,
      found: 3,
      screenedOut: 1,
      passedScreen: 2,
      scored: 2,
      cards: 1,
      bidsSent: 1,
      bidsFailed: 1,
      spentRub: 300,
      clientMessages: 2,
      saraReplies: 1,
    })
  })

  it('FR-NOTIF-4: yesterday ends at Moscow midnight, a week and an explicit span reach back', async () => {
    await seed()
    const y = await periodCounts(db, { period: 'yesterday' }, now)
    expect(y).toMatchObject({ from: '2026-10-30', to: '2026-10-30', untilNow: false, found: 1 })
    expect((await periodCounts(db, { period: 'week' }, now))?.found).toBe(4)
    const span = await periodCounts(db, { from: '2026-10-30', to: '2026-10-30' }, now)
    expect(span?.found).toBe(1)
  })

  it('FR-NOTIF-4: a span that makes no sense is refused, not guessed', () => {
    expect(periodDays({ from: '2026-10-31', to: '2026-10-01' }, now)).toBeNull()
    expect(periodDays({ from: '2026-02-30' }, now)).toBeNull()
    expect(periodDays({ from: '2024-01-01', to: '2026-10-31' }, now)).toBeNull()
    expect(periodDays({}, now)).toEqual({ from: '2026-10-31', to: '2026-10-31' })
  })

  it('FR-NOTIF-4: the tool answers «сколько заявок сегодня» with the journal number, and the role says it comes first', async () => {
    await seed()
    const turn = (): TurnContext => ({
      redactor: createRedactor([]),
      said: { text: 'сколько заявок сегодня', voice: false, at: now },
      questions: [],
      used: [],
    })
    vi.useFakeTimers({ toFake: ['Date'], now })
    const out = await runTool({ db } as SecretaryDeps, turn(), 'counts', { period: 'today' })
    expect(out.isError).toBe(false)
    expect(JSON.parse(out.text)).toMatchObject({ found: 3, cards: 1, bidsSent: 1, bidsFailed: 1 })
    const bad = await runTool({ db } as SecretaryDeps, turn(), 'counts', {
      from: '2026-10-31',
      to: '2026-10-01',
    })
    expect(JSON.parse(bad.text)).toMatchObject({ ok: false })

    const role = await readFile(join(ROOT, 'roles/secretary/role.md'), 'utf8')
    expect(role).toContain('начни ответ с числа')
    expect(role).toContain('Не пиши «в сводке нет»')
    expect(role).not.toContain(String.fromCharCode(0x2014))
  })
})
