import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import {
  event,
  lead,
  leadLabel,
  leadScore,
  ruleProposal,
  task,
} from '../../apps/core/src/db/schema'
import { activeRules, seedDirection } from '../../apps/core/src/direction/store'
import { RULES_V1 } from '../../apps/core/src/direction/v1'
import { dailySummary } from '../../apps/core/src/learning/summary'
import { setSetting } from '../../apps/core/src/settings/store'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { countEvents } from '../../apps/core/test/helpers/events'
import { scorerAnswer } from '../../apps/core/test/helpers/scorer'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

const ROOT = resolve(import.meta.dirname, '../..')
const FIT = { verdict: 'fit', reason: 'Нужен сайт', tags: ['сайт'], confidence: 0.9 }
const ANALYST = analystAnswer('Понимаю задачу.\n\nКогда запуск?', null)
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
/**
 * The first 19:30 Moscow time after now: the summary whose window (19:00 yesterday to 19:00 today) holds an
 * order seen now. After 19:00 an order belongs to tomorrow's summary, so "today 19:30" fails in the evening.
 */
function nextSummary(now = new Date()): Date {
  for (let i = 0; ; i++) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(
      new Date(now.getTime() + i * 86_400_000),
    )
    const at = new Date(`${day}T16:30:00Z`)
    if (at.getTime() - 30 * 60_000 > now.getTime()) return at
  }
}
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
      learningTickMs: 3_600_000,
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
  byRole = { analyst: ANALYST, sorter: FIT, scorer: scorerAnswer(70) }
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
    expect(cards()[0]?.text).toContain(
      '<b>Балл 70</b> (правила v1). Зрелый бизнес, понятная задача',
    )
    const scores = await db.select().from(leadScore).where(eq(leadScore.leadId, id))
    expect(scores).toHaveLength(1)
    expect(scores[0]).toMatchObject({ score: 70, decision: 'show', version: 1, model: 'haiku' })
    expect(await countEvents(db, 'lead.scored', id)).toBe(1)
  })

  it('FR-LEAD-3: an order below the threshold stays silent as scored_out', async () => {
    byRole = { analyst: ANALYST, sorter: FIT, scorer: scorerAnswer(30) }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(async () => (await statusOf(id)) === 'scored_out')
    await new Promise((r) => setTimeout(r, 500))
    expect(cards()).toHaveLength(0)
  })

  it('FR-LEAD-3: an order the Scorer dropped keeps its sorter verdict in the journal', async () => {
    byRole = { analyst: ANALYST, sorter: FIT, scorer: scorerAnswer(30) }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(async () => (await statusOf(id)) === 'scored_out')
    const sorted = await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, 'lead.sorted'), eq(event.entityId, id)))
    expect(sorted.map((e) => e.payload)).toEqual([{ verdict: 'fit', reason: 'Нужен сайт' }])
  })

  it('FR-LEAD-3: a stop factor drops a high score', async () => {
    byRole = { analyst: ANALYST, sorter: FIT, scorer: scorerAnswer(90, { stop_factor: 'direct' }) }
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

  it('FR-LEAD-7: a press on the card writes its label', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const skip = cards()[0]
      ?.reply_markup?.inline_keyboard.flat()
      .find((b) => b.callback_data.endsWith(':skip'))
    tg.pushPress(111, skip?.callback_data ?? '')
    await until(
      async () => (await db.select().from(leadLabel).where(eq(leadLabel.leadId, id))).length === 1,
    )
    const [l] = await db.select().from(leadLabel).where(eq(leadLabel.leadId, id))
    expect(l).toMatchObject({ label: 'no', source: 'card', score: 70, surprise: false })
  })

  it('FR-LEAD-7: skipping a card scored far above the threshold brings «почему?»', async () => {
    byRole = { analyst: ANALYST, sorter: FIT, scorer: scorerAnswer(80) }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const skip = cards()[0]
      ?.reply_markup?.inline_keyboard.flat()
      .find((b) => b.callback_data.endsWith(':skip'))
    tg.pushPress(111, skip?.callback_data ?? '')
    await until(() => tg.sent.some((m) => m.text.startsWith('Почему пропустил «')))
  })

  it('FR-LEAD-7: «Взял бы» is a yes, asks why and brings a normal card; pressing again does nothing', async () => {
    byRole = { analyst: ANALYST, sorter: FIT, scorer: scorerAnswer(50) }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(async () => (await statusOf(id)) === 'scored_out')
    expect(await dailySummary({ db: app.db, notifier: app.bot.notifier }, nextSummary())).toBe(
      'sent',
    )
    await until(() => tg.sent.some((m) => m.text.startsWith('Сегодня отсеяла 1 заявку. На грани:')))
    const want = tg.sent.find((m) => m.text.startsWith('Сегодня отсеяла'))?.reply_markup
      ?.inline_keyboard[0]?.[0]
    expect(want?.text).toBe('Взял бы №1')
    tg.pushPress(111, want?.callback_data ?? '')
    await until(() =>
      cards().some((m) =>
        m.reply_markup?.inline_keyboard[0]?.some((b) => b.callback_data.endsWith(':bid')),
      ),
    )
    await until(() => tg.sent.some((m) => m.text.startsWith('Почему взял бы «')))
    const [l] = await db.select().from(leadLabel).where(eq(leadLabel.leadId, id))
    expect(l).toMatchObject({ label: 'yes', source: 'summary', surprise: true })
    expect(await statusOf(id)).toBe('queued')
    tg.pushPress(111, want?.callback_data ?? '')
    await until(() => tg.answers.some((a) => a.text === 'Уже сделано'))
    expect(
      cards().filter((m) =>
        m.reply_markup?.inline_keyboard[0]?.some((b) => b.callback_data.endsWith(':bid')),
      ),
    ).toHaveLength(1)
  })

  it('FR-MIND-3: «Применить» pressed in Telegram makes the proposed rules active', async () => {
    const proposalId = '0192f3c4-5b6a-7c8d-9e0f-aabbccddeeff'
    const taskId = '0192f3c4-5b6a-7c8d-9e0f-ffeeddccbbaa'
    await db.insert(ruleProposal).values({
      id: proposalId,
      accountId: 'hance-marketing',
      fromVersion: 1,
      rules: { ...RULES_V1, threshold: 60 },
      summary: 'Порог 60',
      why: 'так',
      backtest: { checked: 0, changed: 0, towardBoris: 0, against: 0 },
      state: 'asked',
      taskId,
    })
    await db.insert(task).values({
      id: taskId,
      kind: 'rule_proposal',
      entityKind: 'rule_proposal',
      entityId: proposalId,
    })
    tg.pushPress(111, `t:${taskId}:apply`)
    await until(() => tg.answers.some((a) => a.text === 'Применила, теперь правила v2'))
    expect((await activeRules(db, 'hance-marketing')).rules.threshold).toBe(60)
  })

  it('FR-LEAD-8: a broken label write never blocks the bid or the «Взял бы» card', async () => {
    await setSetting(db, 'outbound.bids', true, 'boris')
    await db.execute(
      sql`create or replace function core.fail_label() returns trigger language plpgsql as $$ begin raise exception 'label down'; end $$`,
    )
    await db.execute(sql`drop trigger if exists fail_label on core.lead_label`)
    await db.execute(
      sql`create trigger fail_label before insert on core.lead_label for each row execute function core.fail_label()`,
    )
    try {
      const id = orderId()
      await fake.emitOrder({ order_id: id })
      await until(() => cards().length === 1)
      const bid = cards()[0]
        ?.reply_markup?.inline_keyboard.flat()
        .find((b) => b.callback_data.endsWith(':bid'))
      tg.pushPress(111, bid?.callback_data ?? '')
      await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
      expect(fake.bids.some((b) => b.idempotency_key === `bid:${id}`)).toBe(true)

      byRole = { analyst: ANALYST, sorter: FIT, scorer: scorerAnswer(50) }
      const dropped = orderId()
      await fake.emitOrder({ order_id: dropped })
      await until(async () => (await statusOf(dropped)) === 'scored_out')
      await dailySummary({ db: app.db, notifier: app.bot.notifier }, nextSummary())
      await until(() => tg.sent.some((m) => m.text.startsWith('Сегодня отсеяла')))
      const want = tg.sent.find((m) => m.text.startsWith('Сегодня отсеяла'))?.reply_markup
        ?.inline_keyboard[0]?.[0]
      tg.pushPress(111, want?.callback_data ?? '')
      await until(() => cards().length === 3)
    } finally {
      await db.execute(sql`drop trigger if exists fail_label on core.lead_label`)
    }
  }, 30000)
})
