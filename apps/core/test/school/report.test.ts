import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lesson, modelCall } from '../../src/db/schema'
import { appendEvent } from '../../src/journal/journal'
import { schoolReport } from '../../src/school/report'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const call = (role: string, model: string, at: Date, priority = 'P3') =>
  db.insert(modelCall).values({
    id: newEventId(),
    role,
    roleVersion: 1,
    model,
    priority,
    startedAt: at.toISOString(),
    durationMs: 1,
    ok: true,
  })

describe('report:school', () => {
  it('NFR-COST-2: the school report shows units by role and the skipped nights', async () => {
    const night = new Date(Date.now() - 60 * 60_000)
    await call('teacher', 'opus', night)
    await call('lesson-maker', 'haiku', night)
    await call('lesson-maker', 'haiku', night)
    await call('sorter', 'haiku', night, 'P2')
    await appendEvent(db, {
      type: 'school.night_skipped',
      v: 1,
      entity: { kind: 'school_job', id: 'generator' },
      account_id: null,
      actor: 'sara',
      occurred_at: night.toISOString(),
      causation_id: null,
      correlation_id: newEventId(),
      reason: null,
      payload: { job: 'generator', reason: 'бюджет: потрачено 398, нужно 40, можно 400' },
    })
    await db
      .insert(lesson)
      .values({ id: newEventId(), source: 'edit', sourceRef: 't1', kind: 'voice', state: 'yes' })
    const r = await schoolReport(db, 7)
    expect(r).toMatch(/teacher: 20/)
    expect(r).toMatch(/lesson-maker: 2/)
    expect(r).not.toMatch(/sorter/)
    expect(r).toMatch(/generator: бюджет: потрачено 398, нужно 40, можно 400/)
    expect(r).toMatch(/edit: да 1/)
    expect(r).toMatch(/Тренировки: пока нет/)
  })
})
