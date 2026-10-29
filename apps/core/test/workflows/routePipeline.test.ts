import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../../tests/fakes/telegramApi'
import { type RunningApp, startApp } from '../../src/app'
import { loadConfig } from '../../src/config'
import { lead, leadCandidate, leadRoute } from '../../src/db/schema'
import { saveProfile, seedProfile } from '../../src/direction/profile'
import { seedDirection } from '../../src/direction/store'
import { setSetting } from '../../src/settings/store'
import { systemDatabaseUrl } from '../../src/workflows/dbos'
import { analystAnswer } from '../helpers/analyst'
import { openTestDb, resetDb, testDatabaseUrl } from '../helpers/db'
import { scorerAnswer } from '../helpers/scorer'

const ROOT = resolve(import.meta.dirname, '../../../..')
const { db, close } = openTestDb()
let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp

beforeAll(async () => {
  tg = await createFakeTelegram()
  fake = await createFakeProfi({
    port: 0,
    coreEventsUrl: 'http://127.0.0.1:1',
    nodeToken: 'node-tok',
    permitSecret: 'permit',
  })
  app = await startApp(
    {
      ...loadConfig({}),
      databaseUrl: testDatabaseUrl(),
      dataDir: await mkdtemp(join(tmpdir(), 'route-')),
      port: 0,
      profiMcpUrl: fake.url,
      nodeToken: 'node-tok',
      permitSecret: 'permit',
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      telegramApiRoot: tg.apiRoot,
    },
    {
      claudeEnv: () => ({
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
          sorter: { verdict: 'fit', reason: 'Нужен сайт', tags: [], confidence: 0.9 },
          scorer: scorerAnswer(70),
          analyst: analystAnswer('Понимаю задачу.'),
        }),
      }),
      retryDelaysMs: [50],
      learningTickMs: 3_600_000,
      notifyRetry: { maxAttempts: 4, intervalSeconds: 0.5 },
    },
  )
  fake.setCoreEventsUrl(`${app.url}/internal/profi/events`)
  await app.secrets.set('claude_oauth_token', 'tok')
  await app.secrets.set('telegram_bot_token', tg.token)
  await app.bot.start(tg.token)
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  await seedProfile(db, 'hance-marketing')
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'pipeline.leads', true, 'boris')
}, 60000)

afterAll(async () => {
  await app.close()
  await fake.close()
  await tg.close()
  await close()
})

async function until(cond: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}

const cards = () => tg.sent.filter((m) => m.reply_markup && m.text.includes('Текст заявки')).length

describe('the router in the lead pipeline (FR-LEAD-4)', () => {
  it('FR-LEAD-4: with one account the order is routed to it and its card comes as before', async () => {
    const id = `${Date.now()}`
    const before = cards()
    await fake.emitOrder({ order_id: id, bid_price_rub: 0 })
    await until(() => cards() === before + 1)
    expect((await db.select().from(leadRoute).where(eq(leadRoute.orderId, id)))[0]).toMatchObject({
      accountId: 'hance-marketing',
      state: 'routed',
      needsChoice: false,
    })
    expect(
      (await db.select().from(leadCandidate).where(eq(leadCandidate.orderId, id)))[0],
    ).toMatchObject({ accountId: 'hance-marketing', decision: 'show' })
    expect((await db.select().from(lead).where(eq(lead.id, id)))[0]?.status).toBe('queued')
  }, 60000)

  it('FR-LEAD-4: a direction in the shadow votes but gets no card, and the order is marked unrouted', async () => {
    await saveProfile(db, 'hance-marketing', { state: 'shadow' }, 'boris')
    try {
      const id = `${Date.now()}`
      const before = cards()
      await fake.emitOrder({ order_id: id, bid_price_rub: 0 })
      await until(
        async () =>
          (await db.select().from(leadRoute).where(eq(leadRoute.orderId, id))).length === 1,
      )
      await new Promise((r) => setTimeout(r, 1500))
      expect(cards()).toBe(before)
      expect((await db.select().from(leadRoute).where(eq(leadRoute.orderId, id)))[0]).toMatchObject(
        {
          accountId: null,
          state: 'none',
        },
      )
      expect((await db.select().from(lead).where(eq(lead.id, id)))[0]?.status).toBe('unrouted')
      expect(
        (await db.select().from(leadCandidate).where(eq(leadCandidate.orderId, id)))[0]?.decision,
      ).toBe('show')
      // The order page is not opened for an order nobody gets.
      expect(fake.orderReads).not.toContain(id)
    } finally {
      await saveProfile(db, 'hance-marketing', { state: 'on' }, 'boris')
    }
  }, 60000)

  it('NFR-REL-3: a run recorded before the router resumes along its old steps, a deploy does not strand it', async () => {
    const id = `${Date.now()}`
    const before = cards()
    await fake.emitOrder({ order_id: id, bid_price_rub: 0 })
    await until(() => cards() === before + 1)
    // The card is out, but the run still records its last steps: take its history only once it has finished.
    const wf = `lead:${id}`
    const sys = new pg.Client({ connectionString: systemDatabaseUrl(testDatabaseUrl()) })
    await sys.connect()
    await until(
      async () =>
        (
          await sys.query<{ status: string }>(
            'select status from dbos.workflow_status where workflow_uuid = $1',
            [wf],
          )
        ).rows[0]?.status === 'SUCCESS',
    )
    const cardsBefore = tg.sent.filter((m) => m.reply_markup).length

    // The history this run would have if the code before the router had recorded it: no marker, no route step.
    try {
      const steps = (
        await sys.query<{ function_id: number; function_name: string }>(
          'select function_id, function_name from dbos.operation_outputs where workflow_uuid = $1 order by function_id',
          [wf],
        )
      ).rows
      const first = steps.find((s) => s.function_name === 'DBOS.patch-router')?.function_id ?? -1
      expect(first).toBeGreaterThan(0)
      const at = steps.findIndex((s) => s.function_id === first)
      expect(steps.slice(at, at + 2).map((s) => s.function_name)).toEqual([
        'DBOS.patch-router',
        'route',
      ])
      await sys.query(
        'delete from dbos.operation_outputs where workflow_uuid = $1 and function_id between $2 and $3',
        [wf, first, first + 1],
      )
      for (const s of steps.filter((x) => x.function_id > first + 1)) {
        await sys.query(
          'update dbos.operation_outputs set function_id = function_id - 2 where workflow_uuid = $1 and function_id = $2',
          [wf, s.function_id],
        )
      }
      await sys.query(
        "update dbos.workflow_status set status = 'CANCELLED' where workflow_uuid = $1",
        [wf],
      )
      const handle = await DBOS.resumeWorkflow(wf)
      await handle.getResult()
      const status = (
        await sys.query<{ status: string }>(
          'select status from dbos.workflow_status where workflow_uuid = $1',
          [wf],
        )
      ).rows[0]?.status
      expect(status).toBe('SUCCESS')
    } finally {
      await sys.end()
    }
    expect(tg.sent.filter((m) => m.reply_markup)).toHaveLength(cardsBefore)
    expect((await db.select().from(lead).where(eq(lead.id, id)))[0]?.status).toBe('queued')
  }, 60000)
})
