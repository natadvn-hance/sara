import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../../tests/fakes/telegramApi'
import { type RunningApp, startApp } from '../../src/app'
import { loadConfig } from '../../src/config'
import { event, lead } from '../../src/db/schema'
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
      dataDir: await mkdtemp(join(tmpdir(), 'replay-')),
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

describe('a run recorded before the order page step', () => {
  it('NFR-REL-3: resumes along its old steps and reads no page, a deploy does not strand it', async () => {
    tg.sent.length = 0
    const id = `${Date.now()}`
    // A slow Telegram: the card is at the bot while the card step is still waiting for the answer.
    tg.setSendDelay(700)
    await fake.emitOrder({ order_id: id, bid_price_rub: 0 })
    await until(() => tg.sent.some((m) => m.reply_markup && m.text.includes('Заявка')))
    expect(fake.orderReads).toEqual([id])
    const cardsBefore = tg.sent.filter((m) => m.reply_markup).length

    // The history this run would have if the code before the page step had recorded it: no marker, no page steps.
    const sys = new pg.Client({ connectionString: systemDatabaseUrl(testDatabaseUrl()) })
    await sys.connect()
    try {
      const wf = `lead:${id}`
      // The card is at the bot before the run has recorded its last step: the history is rewritten only when the run
      // is over, or the card step would be run again on the resume and send a second card.
      await until(
        async () =>
          (
            await sys.query<{ status: string }>(
              'select status from dbos.workflow_status where workflow_uuid = $1',
              [wf],
            )
          ).rows[0]?.status === 'SUCCESS',
      )
      const steps = (
        await sys.query<{ function_id: number; function_name: string }>(
          'select function_id, function_name from dbos.operation_outputs where workflow_uuid = $1 order by function_id',
          [wf],
        )
      ).rows
      const first =
        steps.find((s) => s.function_name === 'DBOS.patch-order-page')?.function_id ?? -1
      expect(first).toBeGreaterThan(0)
      const at = steps.findIndex((s) => s.function_id === first)
      expect(steps.slice(at, at + 4).map((s) => s.function_name)).toEqual([
        'DBOS.patch-order-page',
        'capBeforePage',
        'orderPage',
        'orderPageStored',
      ])
      await sys.query(
        'delete from dbos.operation_outputs where workflow_uuid = $1 and function_id between $2 and $3',
        [wf, first, first + 3],
      )
      for (const s of steps.filter((x) => x.function_id > first + 3)) {
        await sys.query(
          'update dbos.operation_outputs set function_id = function_id - 4 where workflow_uuid = $1 and function_id = $2',
          [wf, s.function_id],
        )
      }
      // Not finished any more, so it can be resumed: the executor runs it again from its recorded steps.
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
    expect(fake.orderReads).toEqual([id])
    expect(tg.sent.filter((m) => m.reply_markup)).toHaveLength(cardsBefore)
    expect((await db.select().from(lead).where(eq(lead.id, id)))[0]?.status).toBe('queued')
  }, 60000)

  it('NFR-REL-3: a card that went out is not sent again when the run restarts before it recorded the card step', async () => {
    tg.setSendDelay(0)
    tg.sent.length = 0
    const id = `${Date.now()}`
    await fake.emitOrder({ order_id: id, bid_price_rub: 0 })
    await until(() => tg.sent.some((m) => m.reply_markup && m.text.includes('Заявка')))
    const cardsBefore = tg.sent.filter((m) => m.reply_markup).length
    const sys = new pg.Client({ connectionString: systemDatabaseUrl(testDatabaseUrl()) })
    await sys.connect()
    try {
      const wf = `lead:${id}`
      await until(
        async () =>
          (
            await sys.query<{ status: string }>(
              'select status from dbos.workflow_status where workflow_uuid = $1',
              [wf],
            )
          ).rows[0]?.status === 'SUCCESS',
      )
      // The core died after the card went out and was written to the task (card.sent), before the run recorded the
      // card step: that step, the last one, is missing from the history and the run is not over.
      const gone = await sys.query(
        "delete from dbos.operation_outputs where workflow_uuid = $1 and function_name = 'card'",
        [wf],
      )
      expect(gone.rowCount).toBe(1)
      await sys.query(
        "update dbos.workflow_status set status = 'CANCELLED' where workflow_uuid = $1",
        [wf],
      )
      const handle = await DBOS.resumeWorkflow(wf)
      await handle.getResult()
    } finally {
      await sys.end()
    }
    await new Promise((r) => setTimeout(r, 300))
    expect(tg.sent.filter((m) => m.reply_markup)).toHaveLength(cardsBefore)
    const sent = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.type, 'card.sent'),
          eq(
            event.correlationId,
            (await db.select().from(lead).where(eq(lead.id, id)))[0]?.correlationId ?? '',
          ),
        ),
      )
    expect(sent).toHaveLength(1)
  }, 60000)
})
