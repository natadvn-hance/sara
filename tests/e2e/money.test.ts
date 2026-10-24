import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { formatRub } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { speedReport } from '../../apps/core/src/analytics/speed'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { event, lead, outbox, task } from '../../apps/core/src/db/schema'
import { dailySummary } from '../../apps/core/src/learning/summary'
import { setSetting } from '../../apps/core/src/settings/store'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

const ROOT = resolve(import.meta.dirname, '../..')
const FIT = '{"verdict":"fit","reason":"Нужен сайт","tags":["сайт"],"confidence":0.9}'
/** The Analyst's draft, so «Откликнуться» has a text to send. */
const ANALYST = { analyst: analystAnswer('Понимаю задачу.\n\nКогда запуск?', null) }
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let n = 0
const orderId = () => `${Date.now()}${n++}`

async function until(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}
const settle = () => new Promise((r) => setTimeout(r, 1000))
const cards = () => tg.sent.filter((m) => m.reply_markup)
const lastCardData = (action: 'bid' | 'skip') => {
  const kb = cards().at(-1)?.reply_markup?.inline_keyboard.flat() ?? []
  return kb.find((b) => b.callback_data.endsWith(`:${action}`))?.callback_data ?? ''
}
async function count(type: string): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(event)
    .where(eq(event.type, type))
  return r[0]?.n ?? 0
}
async function decisionTaskOf(leadId: string) {
  const [t] = await db.select().from(task).where(eq(task.entityId, leadId))
  return t
}
const bidSent = () => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен'))

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
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-money-')),
      port: 0,
      profiMcpUrl: fake.url,
      nodeToken: 'node-tok',
      permitSecret: 'permit',
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      telegramApiRoot: tg.apiRoot,
    },
    {
      claudeEnv: () => ({
        FAKE_CLAUDE_MODE: 'ok',
        FAKE_CLAUDE_OUTPUT: FIT,
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify(ANALYST),
      }),
      retryDelaysMs: [50, 50, 50, 50, 50],
      learningTickMs: 3_600_000,
      remindAfterMs: async () => 3_600_000,
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
  await resetDb(db)
  tg.sent.length = 0
  tg.answers.length = 0
  fake.bids.length = 0
  fake.setHealth({ balance_rub: 5000 })
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'outbound.bids', true, 'boris')
  await setSetting(db, 'pipeline.leads', true, 'boris')
  // Cards come loud unless a test asks otherwise: the clock of the run must not decide.
  await setSetting(db, 'cards.quiet_hours', null, 'boris')
})

describe('money checks before a bid', () => {
  it('FR-LEAD-9: a press over the daily cap answers the reason and writes nothing', async () => {
    await setSetting(db, 'money.daily_bids', 1, 'boris')
    await fake.emitOrder({ order_id: orderId(), bid_price_rub: 210 })
    await until(() => cards().length === 1)
    tg.pushPress(111, lastCardData('bid'))
    await until(bidSent)
    const second = orderId()
    await fake.emitOrder({ order_id: second, bid_price_rub: 210 })
    await until(() => cards().length === 2)
    tg.pushPress(111, lastCardData('bid'))
    await until(() => tg.answers.length === 2)
    expect(tg.answers[1]?.text).toBe(
      'Сегодня уже 1 отклик из 1, это дневной лимит. Отклик не отправила.',
    )
    await settle()
    expect(fake.bids).toHaveLength(1)
    expect(await db.select().from(outbox)).toHaveLength(1)
    expect((await decisionTaskOf(second))?.state).toBe('open')
    expect(await count('task.resolved')).toBe(1)
    expect(await count('bid.requested')).toBe(1)
  })

  it('FR-LEAD-9: after topping up the wallet the same card bids', async () => {
    fake.setHealth({ balance_rub: 100 })
    await fake.emitOrder({ order_id: orderId(), bid_price_rub: 210 })
    await until(() => cards().length === 1)
    tg.pushPress(111, lastCardData('bid'))
    await until(() => tg.answers.length === 1)
    expect(tg.answers[0]?.text).toBe(
      `На кошельке ${formatRub(100)}, а отклик стоит ${formatRub(210)}. Пополни кошелёк и нажми снова.`,
    )
    expect(await db.select().from(outbox)).toHaveLength(0)
    fake.setHealth({ balance_rub: 5000 })
    tg.pushPress(111, lastCardData('bid'))
    await until(bidSent)
    expect(fake.bids).toHaveLength(1)
  })

  it('FR-LEAD-9: an unknown wallet refuses the bid', async () => {
    fake.setHealth({ balance_rub: null })
    const id = orderId()
    await fake.emitOrder({ order_id: id, bid_price_rub: 210 })
    await until(() => cards().length === 1)
    tg.pushPress(111, lastCardData('bid'))
    await until(() => tg.answers.length === 1)
    expect(tg.answers[0]?.text).toBe(
      'Не вижу баланс кошелька на Профи.ру, отклик не отправила. Нажми ещё раз через минуту.',
    )
    expect(fake.bids).toHaveLength(0)
    const [l] = await db.select().from(lead).where(eq(lead.id, id))
    expect(l?.status).toBe('queued')
  })
})

async function eventTypesOf(id: string): Promise<string[]> {
  const [l] = await db.select().from(lead).where(eq(lead.id, id))
  if (!l) return []
  const rows = await db
    .select({ type: event.type })
    .from(event)
    .where(eq(event.correlationId, l.correlationId))
    .orderBy(event.id)
  return rows.map((r) => r.type)
}
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

describe('orders older than 24 hours', () => {
  it('FR-LEAD-10: an order published over 24 hours ago is not sorted, scored or offered', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id, published_at: hoursAgo(25) })
    await until(async () => (await eventTypesOf(id)).includes('lead.stale'))
    await settle()
    expect(await eventTypesOf(id)).toEqual(['profi.order_seen', 'lead.found', 'lead.stale'])
    const [l] = await db.select().from(lead).where(eq(lead.id, id))
    expect(l?.status).toBe('stale')
    expect(cards()).toHaveLength(0)
    expect(await count('model.called')).toBe(0)
  })

  it('FR-LEAD-10: an order published within 24 hours or without a time goes on as before', async () => {
    await fake.emitOrder({ order_id: orderId(), published_at: hoursAgo(23) })
    await fake.emitOrder({ order_id: orderId(), published_at: null })
    await until(() => cards().length === 2)
    expect(await count('lead.stale')).toBe(0)
  })
})

describe('the card flow', () => {
  it('FR-NOTIF-2: a card at quiet hours comes without sound', async () => {
    // Equal hours: quiet all day, whatever the clock of the run.
    await setSetting(db, 'cards.quiet_hours', { from: 4, to: 4 }, 'boris')
    await fake.emitOrder({ order_id: orderId() })
    await until(() => cards().length === 1)
    expect(cards()[0]?.disable_notification).toBe(true)
  })

  it('FR-NOTIF-2: a card outside quiet hours comes with sound', async () => {
    await fake.emitOrder({ order_id: orderId() })
    await until(() => cards().length === 1)
    expect(cards()[0]?.disable_notification).toBeUndefined()
  })

  it("FR-NOTIF-3: past the day's card cap a shown order is held, not sent", async () => {
    await setSetting(db, 'cards.max_per_day', 1, 'boris')
    await fake.emitOrder({ order_id: orderId() })
    await until(() => cards().length === 1)
    const held = orderId()
    await fake.emitOrder({ order_id: held })
    await until(async () => (await eventTypesOf(held)).includes('lead.held'))
    await settle()
    expect(cards()).toHaveLength(1)
    // The draft is written before the cap is checked, so «Показать» later brings the card ready.
    expect(await eventTypesOf(held)).toEqual([
      'profi.order_seen',
      'lead.found',
      'model.called',
      'model.called',
      'lead.drafted',
      'lead.sorted',
      'lead.held',
    ])
    const [l] = await db.select().from(lead).where(eq(lead.id, held))
    expect(l?.status).toBe('held')
    expect(await decisionTaskOf(held)).toBeUndefined()
  })
})

/** 19:30 Moscow time of the summary whose day holds an order seen now. */
function summaryTime(): Date {
  const msk = new Date(Date.now() + 3 * 3600_000)
  if (msk.getUTCHours() >= 19) msk.setUTCDate(msk.getUTCDate() + 1)
  return new Date(`${msk.toISOString().slice(0, 10)}T19:30:00+03:00`)
}

describe('held orders in the summary', () => {
  it('FR-NOTIF-3: «Показать» from the summary brings the held order as a card', async () => {
    await setSetting(db, 'cards.max_per_day', 1, 'boris')
    await fake.emitOrder({ order_id: orderId() })
    await until(() => cards().length === 1)
    const held = orderId()
    await fake.emitOrder({ order_id: held })
    await until(async () => (await eventTypesOf(held)).includes('lead.held'))
    expect(await dailySummary({ db, notifier: app.bot.notifier }, summaryTime())).toBe('sent')
    const summary = tg.sent.at(-1)
    expect(summary?.text).toContain('Ещё показала бы')
    const show = summary?.reply_markup?.inline_keyboard[0]?.[0]
    expect(show?.text).toBe('Показать №1')
    tg.pushPress(111, show?.callback_data ?? '')
    await until(() => tg.answers.length === 1)
    expect(tg.answers[0]?.text).toBe('Прислала карточку заявки')
    const card = tg.sent.at(-1)
    expect(card?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data).toMatch(/:bid$/)
    expect(card?.text).toContain('Черновик отклика:\nИрина, добрый день!\n\nПонимаю задачу.')
    const [l] = await db.select().from(lead).where(eq(lead.id, held))
    expect(l?.status).toBe('queued')
    const decisions = await db.select().from(task).where(eq(task.entityId, held))
    expect(decisions.map((t) => [t.kind, t.state]).sort()).toEqual([
      ['lead_decision', 'open'],
      ['lead_held', 'resolved'],
    ])
    // A second press on the same button changes nothing.
    tg.pushPress(111, show?.callback_data ?? '')
    await until(() => tg.answers.length === 2)
    expect(tg.answers[1]?.text).toBe('Уже сделано')
    // Boris has not decided yet: no label is written for the opened card.
    expect(await count('lead.labeled')).toBe(0)
    // The card came hours after the order: it is not a lead-to-card time (FR-ANL-3).
    const [l2] = await db.select().from(lead).where(eq(lead.id, held))
    const created = await db
      .select({ payload: event.payload })
      .from(event)
      .where(sql`${event.correlationId} = ${l2?.correlationId} and ${event.type} = 'task.created'`)
    expect(created.map((e) => (e.payload as { via?: string }).via)).toEqual(['summary'])
    expect((await speedReport(db)).leadToCard.count).toBe(1)
  })

  it('FR-LEAD-10: «Показать» on an order seen over 24 hours ago brings no card', async () => {
    await setSetting(db, 'cards.max_per_day', 1, 'boris')
    await fake.emitOrder({ order_id: orderId() })
    await until(() => cards().length === 1)
    const held = orderId()
    await fake.emitOrder({ order_id: held })
    await until(async () => (await eventTypesOf(held)).includes('lead.held'))
    expect(await dailySummary({ db, notifier: app.bot.notifier }, summaryTime())).toBe('sent')
    const show = tg.sent.at(-1)?.reply_markup?.inline_keyboard[0]?.[0]
    // Pressed the next evening: the order is over a day old.
    await db
      .update(lead)
      .set({ seenAt: hoursAgo(25) })
      .where(eq(lead.id, held))
    const before = cards().length
    tg.pushPress(111, show?.callback_data ?? '')
    await until(() => tg.answers.length === 1)
    expect(tg.answers[0]?.text).toBe('Заявке больше суток, карточку не присылаю.')
    await settle()
    expect(cards()).toHaveLength(before)
    expect(await decisionTaskOf(held)).toMatchObject({ kind: 'lead_held', state: 'open' })
  })
})
