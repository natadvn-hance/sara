import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { jobRun } from '../../src/db/schema'
import { appendEvent } from '../../src/journal/journal'
import type { Notifier } from '../../src/notify/notifier'
import { syncNoticeStep } from '../../src/school/syncNotice'
import { SCHOOL_TEXTS } from '../../src/school/texts'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const msk = (hhmm: string) => new Date(`2026-10-26T${hhmm}:00+03:00`)

function notifier(o: { down?: boolean } = {}) {
  const texts: string[] = []
  const n: Notifier = {
    sendLeadCard: async () => ({ messageId: 1 }),
    sendText: async (text) => {
      if (o.down) throw new Error('telegram is down')
      texts.push(text)
      return { messageId: 2 }
    },
    sendButtons: async () => ({ messageId: 3 }),
    editText: async () => {},
  }
  return { n, texts }
}

async function syncFailed(at: Date) {
  await appendEvent(db, {
    type: 'mind.sync_failed',
    v: 1,
    entity: { kind: 'mind', id: 'sara-mind' },
    account_id: null,
    actor: 'sara',
    occurred_at: at.toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { error: 'push rejected' },
  })
}

describe('the night exchange failure notice', () => {
  it('FR-MIND-3: a failed night exchange is told once, in the school hours', async () => {
    await syncFailed(msk('05:30'))
    const f = notifier()
    await syncNoticeStep({ db, notifier: f.n }, msk('07:00'))
    expect(f.texts).toEqual([])
    await syncNoticeStep({ db, notifier: f.n }, msk('10:00'))
    await syncNoticeStep({ db, notifier: f.n }, msk('10:01'))
    expect(f.texts).toEqual([SCHOOL_TEXTS.syncFailed])
  })

  it('FR-MIND-3: a notice Telegram refused gives the place back and goes on the next tick', async () => {
    await syncFailed(msk('05:30'))
    await expect(
      syncNoticeStep({ db, notifier: notifier({ down: true }).n }, msk('10:00')),
    ).rejects.toThrow('telegram is down')
    expect(await db.select().from(jobRun)).toEqual([])
    const f = notifier()
    await syncNoticeStep({ db, notifier: f.n }, msk('10:01'))
    expect(f.texts).toEqual([SCHOOL_TEXTS.syncFailed])
  })
})
