import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedDirection } from '../../src/direction/store'
import type { Gateway } from '../../src/gateway/gateway'
import { LEARNING_STEPS, startLearningJobs } from '../../src/learning/jobs'
import type { Notifier } from '../../src/notify/notifier'
import { openTestDb, resetDb } from '../helpers/db'
import { droppedLead } from '../helpers/learning'

const { db, close } = openTestDb()
afterAll(close)
let sent: string[] = []
const notifier: Notifier = {
  sendLeadCard: async () => ({ messageId: 1 }),
  closeLeadCard: async () => {},
  sendText: async (t) => {
    sent.push(t)
    return { messageId: 2 }
  },
  sendButtons: async (t) => {
    sent.push(t)
    return { messageId: 3 }
  },
}
const gateway = { call: async () => ({ ok: false }) } as unknown as Gateway
beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  sent = []
})

describe('learning tick', () => {
  it('FR-LEAD-7: the tick runs the weak noes, the daily summary and the rule proposals', () => {
    expect(LEARNING_STEPS.map((s) => s.name)).toEqual(['ignored', 'summary', 'proposals'])
  })

  it('FR-LEAD-7: a tick at 19:30 Moscow time sends the day summary', async () => {
    await droppedLead(db, '950001', 50, { seenAt: '2026-10-25T07:00:00Z' })
    const jobs = startLearningJobs({
      db,
      notifier,
      gateway,
      accountIds: ['hance-marketing'],
      now: () => new Date('2026-10-25T16:30:00Z'),
      tickMs: 3_600_000,
    })
    await jobs.tick()
    jobs.stop()
    expect(sent[0]).toMatch(/^Сегодня отсеяла 1 заявку\. На грани:/)
  })
})
