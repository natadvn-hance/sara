import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { speedReport } from '../../apps/core/src/analytics/speed'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { deal, event, lead } from '../../apps/core/src/db/schema'
import { setSetting } from '../../apps/core/src/settings/store'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

const ROOT = resolve(import.meta.dirname, '../..')
const FIT = '{"verdict":"fit","reason":"Нужен сайт","tags":["сайт"],"confidence":0.9}'
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
  const kb = cards().at(-1)?.reply_markup?.inline_keyboard[0] ?? []
  return kb.find((b) => b.callback_data.endsWith(`:${action}`))?.callback_data ?? ''
}
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
async function count(type: string): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(event)
    .where(eq(event.type, type))
  return r[0]?.n ?? 0
}
let claudeMode = 'ok'

beforeAll(async () => {
  tg = await createFakeTelegram()
  fake = await createFakeProfi({
    port: 0,
    coreEventsUrl: 'http://127.0.0.1:1',
    nodeToken: 'node-tok',
    permitSecret: 'permit',
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'e2e-'))
  const config = {
    ...loadConfig({}),
    databaseUrl: testDatabaseUrl(),
    dataDir,
    port: 0,
    profiMcpUrl: fake.url,
    nodeToken: 'node-tok',
    permitSecret: 'permit',
    claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
    telegramApiRoot: tg.apiRoot,
  }
  app = await startApp(config, {
    claudeEnv: () => ({ FAKE_CLAUDE_MODE: claudeMode, FAKE_CLAUDE_OUTPUT: FIT }),
    retryDelaysMs: [50, 50, 50, 50, 50],
  })
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
  claudeMode = 'ok'
  await resetDb(db)
  tg.sent.length = 0
  tg.answers.length = 0
  fake.bids.length = 0
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'outbound.bids', true, 'boris')
})

describe('walking skeleton', () => {
  it('FR-LEAD-7: order_seen becomes a lead card in Telegram', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    expect(cards()[0]?.text).toContain('Подходит: Нужен сайт')
    expect(await eventTypesOf(id)).toEqual([
      'profi.order_seen',
      'lead.found',
      'model.called',
      'lead.sorted',
      'task.created',
    ])
  })

  it('FR-LEAD-8: pressing bid sends one bid with a greeting and confirms in Telegram', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    tg.pushPress(111, lastCardData('bid'))
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    expect(fake.bids).toHaveLength(1)
    expect(fake.bids[0]?.text).toMatch(/^Добрый день!/)
    expect(fake.bids[0]?.idempotency_key).toBe(`bid:${id}`)
    expect(await count('bid.sent')).toBe(1)
    const [d] = await db.select().from(deal).where(eq(deal.leadId, id))
    expect(d?.stage).toBe('bid_sent')
  })

  it('FR-LEAD-4: two near-simultaneous presses give one bid', async () => {
    await fake.emitOrder({ order_id: orderId() })
    await until(() => cards().length === 1)
    tg.pushPress(111, lastCardData('bid'))
    tg.pushPress(111, lastCardData('bid'))
    await until(() => tg.answers.length === 2)
    await settle()
    expect(fake.bids).toHaveLength(1)
    expect(tg.answers.map((a) => a.text)).toContain('Уже сделано')
  })

  it('NFR-REL-4: lost acknowledgement after the bid went out does not create a second bid', async () => {
    await fake.emitOrder({ order_id: orderId() })
    await until(() => cards().length === 1)
    fake.failNextAck()
    tg.pushPress(111, lastCardData('bid'))
    await until(async () => (await count('bid.sent')) === 1)
    expect(fake.bids).toHaveLength(1)
  })

  it('FR-LEAD-2: sorter failure still delivers the card', async () => {
    claudeMode = 'exit1'
    await fake.emitOrder({ order_id: orderId() })
    await until(() => cards().length === 1)
    expect(cards()[0]?.text).toContain('Сортировщик не ответил, проверь сам')
    expect(await count('model.failed')).toBe(1)
  })

  it('FR-LEAD-1: two events with the same order number give one lead and one card', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    await settle()
    expect(cards()).toHaveLength(1)
    const rows = await db.select().from(lead).where(eq(lead.id, id))
    expect(rows).toHaveLength(1)
  })

  it('FR-OPS-1: paused bids do not reach Profi', async () => {
    await setSetting(db, 'outbound.bids', false, 'boris')
    await fake.emitOrder({ order_id: orderId() })
    await until(() => cards().length === 1)
    tg.pushPress(111, lastCardData('bid'))
    await until(() => tg.sent.some((m) => m.text === 'Отклик не ушёл: отправка откликов на паузе'))
    expect(fake.bids).toHaveLength(0)
    expect(await count('bid.failed')).toBe(1)
  })

  it('FR-LEAD-7: skip resolves the task without a bid', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    tg.pushPress(111, lastCardData('skip'))
    await until(() => tg.answers.length === 1)
    expect(tg.answers[0]?.text).toBe('Пропущено')
    const [l] = await db
      .select()
      .from(lead)
      .where(and(eq(lead.id, id)))
    expect(l?.status).toBe('skipped')
    expect(fake.bids).toHaveLength(0)
  })

  it('FR-NOTIF-1: card that cannot be sent is journaled and the lead is kept', async () => {
    await app.bot.stop()
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(async () => (await count('notify.failed')) === 1)
    const [l] = await db.select().from(lead).where(eq(lead.id, id))
    expect(l?.status).toBe('queued')
    await app.bot.start(tg.token)
  })

  it('G1, G2: speed report has both timings for the passed order', async () => {
    await fake.emitOrder({ order_id: orderId() })
    await until(() => cards().length === 1)
    tg.pushPress(111, lastCardData('bid'))
    await until(async () => (await count('bid.sent')) === 1)
    const r = await speedReport(db)
    expect(r.leadToCard.count).toBe(1)
    expect(r.yesToBid.count).toBe(1)
    expect(r.leadToCard.p90Ms).not.toBeNull()
  })
})
