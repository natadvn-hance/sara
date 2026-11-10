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
/** The Scorer's points for the next orders (70 shows, 30 drops). */
let points = 70

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
          scorer: scorerAnswer(points),
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

type Step = { function_id: number; function_name: string }

/** The steps a run recorded, in order. */
async function historyOf(sys: pg.Client, wf: string): Promise<Step[]> {
  return (
    await sys.query<Step>(
      'select function_id, function_name from dbos.operation_outputs where workflow_uuid = $1 order by function_id',
      [wf],
    )
  ).rows
}

async function statusOf(sys: pg.Client, wf: string): Promise<string | undefined> {
  return (
    await sys.query<{ status: string }>(
      'select status from dbos.workflow_status where workflow_uuid = $1',
      [wf],
    )
  ).rows[0]?.status
}

/**
 * The history an older code would have recorded: the `window` steps from `first` on are replaced by `older` (names
 * of steps from that window, in the order the older code ran them; the rest of the window goes), and every step after
 * the window moves up by the number that went.
 */
async function rewrite(
  sys: pg.Client,
  wf: string,
  first: number,
  window: string[],
  older: string[],
): Promise<void> {
  const steps = await historyOf(sys, wf)
  const at = steps.findIndex((s) => s.function_id === first)
  expect(steps.slice(at, at + window.length).map((s) => s.function_name)).toEqual(window)
  const idOf = (name: string) => first + window.indexOf(name)
  const gone = window.length - older.length
  // Out of the way first: a run's step numbers are unique.
  await sys.query(
    'update dbos.operation_outputs set function_id = function_id + 10000 where workflow_uuid = $1 and function_id >= $2',
    [wf, first],
  )
  for (const name of window.filter((n) => !older.includes(n)))
    await sys.query(
      'delete from dbos.operation_outputs where workflow_uuid = $1 and function_id = $2',
      [wf, idOf(name) + 10000],
    )
  for (const [i, name] of older.entries())
    await sys.query(
      'update dbos.operation_outputs set function_id = $3 where workflow_uuid = $1 and function_id = $2',
      [wf, idOf(name) + 10000, first + i],
    )
  await sys.query(
    'update dbos.operation_outputs set function_id = function_id - 10000 - $3 where workflow_uuid = $1 and function_id >= $2',
    [wf, first + window.length + 10000, gone],
  )
}

/** Resumes a finished run as if the core had died before its end: the executor runs it again from its history. */
async function replay(sys: pg.Client, wf: string): Promise<void> {
  await sys.query("update dbos.workflow_status set status = 'CANCELLED' where workflow_uuid = $1", [
    wf,
  ])
  const handle = await DBOS.resumeWorkflow(wf)
  await handle.getResult()
  expect(await statusOf(sys, wf)).toBe('SUCCESS')
}

/** The steps a run records now around the Scorer and the order page, from the marker read with the score on. */
const NOW_STEPS = [
  'DBOS.patch-page-with-score',
  'capBeforePage',
  'orderPage',
  'score',
  'scored',
  'DBOS.patch-router',
  'route',
  'DBOS.patch-order-page',
  'orderPageStored',
  // The screen's profile check (docs/product/lead-analysis.md) follows the page read.
  'screenPage',
]

describe('a run recorded before the order page step', () => {
  it('NFR-REL-3: resumes along its old steps and reads no page, a deploy does not strand it', async () => {
    tg.sent.length = 0
    const id = `${Date.now()}`
    // A slow Telegram: the card is at the bot while the card step is still waiting for the answer.
    tg.setSendDelay(700)
    await fake.emitOrder({ order_id: id, bid_price_rub: 0 })
    await until(() => tg.sent.some((m) => m.reply_markup && m.text.includes('Текст заявки')))
    expect(fake.orderReads).toEqual([id])
    const cardsBefore = tg.sent.filter((m) => m.reply_markup).length

    const sys = new pg.Client({ connectionString: systemDatabaseUrl(testDatabaseUrl()) })
    await sys.connect()
    try {
      const wf = `lead:${id}`
      // The card is at the bot before the run has recorded its last step: the history is rewritten only when the run
      // is over, or the card step would be run again on the resume and send a second card.
      await until(async () => (await statusOf(sys, wf)) === 'SUCCESS')
      const first =
        (await historyOf(sys, wf)).find((s) => s.function_name === 'DBOS.patch-page-with-score')
          ?.function_id ?? -1
      expect(first).toBeGreaterThan(0)
      // The history this run would have if the code before the page step had recorded it: no marker, no page steps.
      await rewrite(sys, wf, first, NOW_STEPS, ['score', 'scored', 'DBOS.patch-router', 'route'])
      await replay(sys, wf)
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
    await until(() => tg.sent.some((m) => m.reply_markup && m.text.includes('Текст заявки')))
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

describe('a run recorded before the page was read alongside the Scorer', () => {
  it('NFR-REL-3: resumes along its old steps, the page read after the score, and reads no page again', async () => {
    tg.setSendDelay(0)
    tg.sent.length = 0
    fake.orderReads.length = 0
    const id = `${Date.now()}`
    await fake.emitOrder({ order_id: id, bid_price_rub: 0 })
    await until(() => tg.sent.some((m) => m.reply_markup && m.text.includes('Текст заявки')))
    const cardsBefore = tg.sent.filter((m) => m.reply_markup).length
    const sys = new pg.Client({ connectionString: systemDatabaseUrl(testDatabaseUrl()) })
    await sys.connect()
    try {
      const wf = `lead:${id}`
      await until(async () => (await statusOf(sys, wf)) === 'SUCCESS')
      const first =
        (await historyOf(sys, wf)).find((s) => s.function_name === 'DBOS.patch-page-with-score')
          ?.function_id ?? -1
      expect(first).toBeGreaterThan(0)
      // What the code before this change recorded: the cap check and the page read after the route, under 'order-page'.
      await rewrite(sys, wf, first, NOW_STEPS, [
        'score',
        'scored',
        'DBOS.patch-router',
        'route',
        'DBOS.patch-order-page',
        'capBeforePage',
        'orderPage',
        'orderPageStored',
        'screenPage',
      ])
      await replay(sys, wf)
    } finally {
      await sys.end()
    }
    expect(fake.orderReads).toEqual([id])
    expect(tg.sent.filter((m) => m.reply_markup)).toHaveLength(cardsBefore)
    expect((await db.select().from(lead).where(eq(lead.id, id)))[0]?.status).toBe('queued')
  }, 60000)

  it('FR-LEAD-2: a dropped order ends its run only after the page read it started, no step is left running', async () => {
    tg.setSendDelay(0)
    fake.orderReads.length = 0
    const id = `${Date.now()}`
    // The page answers well after the Scorer: a run that did not wait would be over before the read is recorded.
    fake.setOrderPage(id, { delayMs: 1500 })
    points = 30
    try {
      await fake.emitOrder({ order_id: id, bid_price_rub: 0 })
      const sys = new pg.Client({ connectionString: systemDatabaseUrl(testDatabaseUrl()) })
      await sys.connect()
      try {
        const wf = `lead:${id}`
        await until(async () => (await statusOf(sys, wf)) === 'SUCCESS')
        const names = (await historyOf(sys, wf)).map((s) => s.function_name)
        expect(names).toContain('orderPage')
        expect(names.indexOf('orderPage')).toBeLessThan(names.indexOf('score'))
        // Dropped: nothing after the route, the page is not kept.
        expect(names.at(-1)).toBe('route')
        expect(names).not.toContain('orderPageStored')
      } finally {
        await sys.end()
      }
    } finally {
      points = 70
    }
    expect(fake.orderReads).toEqual([id])
    expect((await db.select().from(lead).where(eq(lead.id, id)))[0]?.status).toBe('scored_out')
  }, 60000)
})
