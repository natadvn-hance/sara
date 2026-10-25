import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lead } from '../../src/db/schema'
import { rulesHash } from '../../src/direction/hash'
import { seedDirection } from '../../src/direction/store'
import { ClaudeStopError, orderOfLead, trialScore } from '../../src/direction/trial'
import { RULES_V1 } from '../../src/direction/v1'
import { withoutLimitWait } from '../../src/gateway/gateway'
import { openTestDb, resetDb } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'
import { leadWithScore } from '../helpers/learning'
import { scorerAnswer } from '../helpers/scorer'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, ACC)
  await leadWithScore(db, '950001', 70)
})

const trialRows = async () =>
  (await db.execute(sql`select * from core.trial_score order by created_at`)).rows

describe('trial scores', { timeout: 30000 }, () => {
  it('FR-ACC-5: a trial scores a lead under the given rules and keeps the result', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    const r = await trialScore({ db, ...f }, '950001', RULES_V1, 'plain')
    expect(r).toMatchObject({ score: 70, decision: 'show', model: 'haiku', stopFactor: null })
    const rows = await trialRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      rules_hash: rulesHash(RULES_V1),
      lead_id: '950001',
      mode: 'plain',
      score: 70,
    })
  })

  it('FR-ACC-5: a second trial of the same lead and rules does not call the model', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    await trialScore({ db, ...f }, '950001', RULES_V1, 'plain')
    const again = await trialScore({ db, ...f }, '950001', RULES_V1, 'plain')
    expect(again?.score).toBe(70)
    expect(await f.calls()).toHaveLength(1)
  })

  it('FR-ACC-5: other rules, another mode and another role version are scored again', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    await trialScore({ db, ...f }, '950001', RULES_V1, 'plain')
    await trialScore({ db, ...f }, '950001', { ...RULES_V1, threshold: 40 }, 'plain')
    await trialScore({ db, ...f }, '950001', RULES_V1, 'escalated')
    expect(await f.calls()).toHaveLength(3)
    const meta = join(f.rolesDir, 'scorer/meta.json')
    const now = JSON.parse(await readFile(meta, 'utf8')) as { version: number }
    await writeFile(meta, JSON.stringify({ ...now, version: now.version + 1 }))
    await trialScore({ db, ...f }, '950001', RULES_V1, 'plain')
    expect(await f.calls()).toHaveLength(4)
    expect(await trialRows()).toHaveLength(4)
  })

  it('FR-ACC-5: a model miss is not cached', async () => {
    const miss = await fakeGateway(db, { scorer: scorerAnswer(70) }, { FAKE_CLAUDE_MODE: 'exit1' })
    expect(await trialScore({ db, ...miss }, '950001', RULES_V1, 'plain')).toBeNull()
    expect(await trialRows()).toHaveLength(0)
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    expect((await trialScore({ db, ...f }, '950001', RULES_V1, 'plain'))?.score).toBe(70)
  })

  it('FR-ACC-5: the Claude limit is an error, not a miss, and is not cached', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) }, { FAKE_CLAUDE_MODE: 'limit' })
    const d = { db, gateway: withoutLimitWait(f.gateway), rolesDir: f.rolesDir }
    await expect(trialScore(d, '950001', RULES_V1, 'plain')).rejects.toBeInstanceOf(ClaudeStopError)
    expect(await trialRows()).toHaveLength(0)
  })

  it('FR-ACC-5: plain never asks sonnet, escalated does near the threshold', async () => {
    const f = await fakeGateway(db, {
      'scorer@haiku': scorerAnswer(56),
      'scorer@sonnet': scorerAnswer(60),
    })
    const plain = await trialScore({ db, ...f }, '950001', RULES_V1, 'plain')
    expect(plain).toMatchObject({ score: 56, model: 'haiku' })
    expect((await f.calls()).map((c) => c.model)).toEqual(['haiku'])
    const escalated = await trialScore({ db, ...f }, '950001', RULES_V1, 'escalated')
    expect(escalated).toMatchObject({ score: 60, model: 'sonnet' })
    expect((await f.calls()).map((c) => c.model)).toEqual(['haiku', 'haiku', 'sonnet'])
  })

  it('FR-ACC-5: a trial is queued as P3 so live scoring goes first', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    await trialScore({ db, ...f }, '950001', RULES_V1, 'plain')
    const rows = await db.execute<{ priority: string }>(sql`select priority from core.model_call`)
    expect(rows.rows.map((r) => r.priority)).toEqual(['P3'])
  })

  it('FR-ACC-5: the order a trial scores has no client name, and the model never gets it', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    const [row] = await db.select().from(lead).where(eq(lead.id, '950001'))
    expect(row?.clientName).toBe('Андрей')
    expect(orderOfLead(row as typeof lead.$inferSelect).client_name).toBe('')
    await trialScore({ db, ...f }, '950001', RULES_V1, 'plain')
    expect((await f.calls())[0]?.stdin).not.toContain('Андрей')
  })

  it('FR-LEAD-1: a raised-again lead is scored in a trial with the same fact as live', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    await db
      .update(lead)
      .set({ reposted: true, repostNotice: 'Клиент запросил ещё отклики 4 дня назад' })
      .where(eq(lead.id, '950001'))
    const [row] = await db.select().from(lead).where(eq(lead.id, '950001'))
    expect(orderOfLead(row as typeof lead.$inferSelect)).toMatchObject({
      reposted: true,
      repost_notice: 'Клиент запросил ещё отклики 4 дня назад',
    })
    await trialScore({ db, ...f }, '950001', RULES_V1, 'plain')
    expect((await f.calls())[0]?.stdin).toContain(
      'Заказ поднят повторно: старый заказ, клиент ещё не нашёл исполнителя. Сайт пишет: Клиент запросил ещё отклики 4 дня назад',
    )
  })

  it('FR-ACC-5: a lead that does not exist is no trial', async () => {
    const f = await fakeGateway(db, { scorer: scorerAnswer(70) })
    expect(await trialScore({ db, ...f }, 'nope', RULES_V1, 'plain')).toBeNull()
    expect(await f.calls()).toHaveLength(0)
  })
})
