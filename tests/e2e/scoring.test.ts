import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { lead, leadScore } from '../../apps/core/src/db/schema'
import { seedDirection } from '../../apps/core/src/direction/store'
import { setSetting } from '../../apps/core/src/settings/store'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { countEvents } from '../../apps/core/test/helpers/events'
import { scorerAnswer } from '../../apps/core/test/helpers/scorer'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

const ROOT = resolve(import.meta.dirname, '../..')
const FIT = { verdict: 'fit', reason: 'Нужен сайт', tags: ['сайт'], confidence: 0.9 }
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let n = 0
const orderId = () => `${Date.now()}${n++}`
/** What each role answers in the next calls (fake Claude reads it per call). */
let byRole: Record<string, unknown> = {}

export async function until(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}
const cards = () => tg.sent.filter((m) => m.reply_markup)
const statusOf = async (id: string) =>
  (await db.select({ s: lead.status }).from(lead).where(eq(lead.id, id)))[0]?.s

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
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-score-')),
      port: 0,
      profiMcpUrl: fake.url,
      nodeToken: 'node-tok',
      permitSecret: 'permit',
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      telegramApiRoot: tg.apiRoot,
    },
    {
      claudeEnv: () => ({ FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify(byRole) }),
      retryDelaysMs: [50, 50, 50, 50, 50],
      notifyRetry: { maxAttempts: 4, intervalSeconds: 0.5 },
    },
  )
  fake.setCoreEventsUrl(`${app.url}/internal/profi/events`)
  await app.secrets.set('claude_oauth_token', 'tok')
  await app.secrets.set('telegram_bot_token', tg.token)
  await app.bot.start(tg.token)
}, 60000)

afterAll(async () => {
  await app.close()
  await fake.close()
  await tg.close()
  await close()
})

beforeEach(async () => {
  byRole = { sorter: FIT, scorer: scorerAnswer(70) }
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  tg.sent.length = 0
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'pipeline.leads', true, 'boris')
})

describe('scoring in the lead pipeline', () => {
  it('FR-LEAD-3: an order above the threshold becomes a card with its score', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    expect(cards()[0]?.text).toContain('Балл 70 (правила v1). Зрелый бизнес, понятная задача')
    const scores = await db.select().from(leadScore).where(eq(leadScore.leadId, id))
    expect(scores).toHaveLength(1)
    expect(scores[0]).toMatchObject({ score: 70, decision: 'show', version: 1, model: 'haiku' })
    expect(await countEvents(db, 'lead.scored', id)).toBe(1)
  })

  it('FR-LEAD-3: an order below the threshold stays silent as scored_out', async () => {
    byRole = { sorter: FIT, scorer: scorerAnswer(30) }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(async () => (await statusOf(id)) === 'scored_out')
    await new Promise((r) => setTimeout(r, 500))
    expect(cards()).toHaveLength(0)
  })

  it('FR-LEAD-3: a stop factor drops a high score', async () => {
    byRole = { sorter: FIT, scorer: scorerAnswer(90, { stop_factor: 'direct' }) }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(async () => (await statusOf(id)) === 'scored_out')
    expect(cards()).toHaveLength(0)
  })

  it('FR-LEAD-3: a failed Scorer still brings the card, marked without a score', async () => {
    byRole = { sorter: FIT, scorer: { nothing: true } }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    expect(cards()[0]?.text).toContain('Без оценки: Оценщик не ответил')
    expect(await db.select().from(leadScore).where(eq(leadScore.leadId, id))).toHaveLength(0)
  })
})
