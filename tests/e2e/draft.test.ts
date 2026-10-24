import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { event, lead, outbox, task } from '../../apps/core/src/db/schema'
import { seedDirection } from '../../apps/core/src/direction/store'
import { dailySummary } from '../../apps/core/src/learning/summary'
import { setSetting } from '../../apps/core/src/settings/store'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { scorerAnswer } from '../../apps/core/test/helpers/scorer'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

const ROOT = resolve(import.meta.dirname, '../..')
const FIT = { verdict: 'fit', reason: 'Нужен сайт', tags: ['сайт'], confidence: 0.9 }
const BODY = 'Понимаю, клинике важно быстро начать запись.\n\nКогда хотите открыть запись онлайн?'
const ANALYST = { hidden_need: 'Боится долгого запуска', text: BODY, price_rub: 90000 }
/** The sample order 90000001: client Ирина, budget «до 150 000 ₽». */
const DRAFT = `Ирина, добрый день!\n\n${BODY}`
const NBSP = ' '
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let n = 0
const orderId = () => `${Date.now()}${n++}`
/** What each role answers in the next calls (fake Claude reads it per call). */
let byRole: Record<string, unknown> = {}

async function until(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}
const cards = () => tg.sent.filter((m) => m.reply_markup)
const button = (m: (typeof tg.sent)[number] | undefined, action: string) =>
  m?.reply_markup?.inline_keyboard.flat().find((b) => b.callback_data.endsWith(`:${action}`))
    ?.callback_data ?? ''
const leadOf = async (id: string) => (await db.select().from(lead).where(eq(lead.id, id)))[0]
const eventsOf = (type: string, id: string) =>
  db
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.type, type), eq(event.entityId, id)))
const analystCalls = async () =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(event)
      .where(
        sql`${event.type} in ('model.called', 'model.failed') and ${event.payload}->>'role' = 'analyst'`,
      )
  )[0]?.n ?? 0

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
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-draft-')),
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
  byRole = { sorter: FIT, scorer: scorerAnswer(70), analyst: ANALYST }
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  tg.sent.length = 0
  tg.answers.length = 0
  fake.bids.length = 0
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'pipeline.leads', true, 'boris')
  await setSetting(db, 'outbound.bids', true, 'boris')
})

describe('the draft on the card', () => {
  it('FR-LEAD-6: a shown order comes as a card with the Analyst draft and the price', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    expect(cards()[0]?.text).toContain(`Черновик отклика:\n${DRAFT}`)
    expect(cards()[0]?.text).toContain(`Стоимость услуги: 90${NBSP}000${NBSP}₽`)
    expect(await leadOf(id)).toMatchObject({ draftText: DRAFT, draftPriceRub: 90000 })
    expect((await eventsOf('lead.drafted', id)).map((e) => e.payload)).toEqual([
      { drafted: true, chars: DRAFT.length, price_rub: 90000, attempts: 1, reason: null },
    ])
  })

  it('FR-LEAD-7: without an Analyst answer the card comes without a draft', async () => {
    byRole = { ...byRole, analyst: { nothing: true } }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    expect(cards()[0]?.text).toContain('Черновика нет: Аналитик не ответил.')
    expect(await leadOf(id)).toMatchObject({ draftText: null, draftPriceRub: null })
    expect((await eventsOf('lead.drafted', id)).map((e) => e.payload)).toEqual([
      { drafted: false, chars: null, price_rub: null, attempts: 1, reason: 'no_answer' },
    ])
  })

  it('FR-LEAD-6: an order the Scorer dropped gets no draft call', async () => {
    byRole = { ...byRole, scorer: scorerAnswer(30) }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(async () => (await leadOf(id))?.status === 'scored_out')
    await new Promise((r) => setTimeout(r, 300))
    expect(await analystCalls()).toBe(0)
    expect(cards()).toHaveLength(0)
  })

  it('FR-LEAD-7: a card sent again carries the draft', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const [t] = await db.select().from(task).where(eq(task.entityId, id))
    await app.pipeline.resendCard(t?.id ?? '')
    await until(() => cards().length === 2)
    expect(cards()[1]?.text).toContain(`Черновик отклика:\n${DRAFT}`)
  })

  it('FR-LEAD-7: «Взял бы» brings a card with a draft', async () => {
    byRole = { ...byRole, scorer: scorerAnswer(50) }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(async () => (await leadOf(id))?.status === 'scored_out')
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date())
    await dailySummary({ db: app.db, notifier: app.bot.notifier }, new Date(`${day}T16:30:00Z`))
    await until(() => tg.sent.some((m) => m.text.startsWith('Сегодня отсеяла')))
    const summary = tg.sent.find((m) => m.text.startsWith('Сегодня отсеяла'))
    tg.pushPress(111, summary?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? '')
    await until(() => tg.answers.some((a) => a.text === 'Пишу черновик, пришлю карточку'))
    await until(() => cards().some((m) => button(m, 'bid') !== ''))
    expect(cards().find((m) => button(m, 'bid') !== '')?.text).toContain(
      `Черновик отклика:\n${DRAFT}`,
    )
    expect(await leadOf(id)).toMatchObject({ draftText: DRAFT, draftPriceRub: 90000 })
  })
})

describe('the bid', () => {
  it('FR-LEAD-8: «Откликнуться» sends the draft and its price', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    tg.pushPress(111, button(cards()[0], 'bid'))
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    expect(fake.bids).toHaveLength(1)
    expect(fake.bids[0]).toMatchObject({ order_id: id, text: DRAFT, price_rub: 90000 })
  })

  it('FR-LEAD-7: «Откликнуться» without a draft asks for «Изменить» and records nothing', async () => {
    byRole = { ...byRole, analyst: { nothing: true } }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    tg.pushPress(111, button(cards()[0], 'bid'))
    await until(() => tg.answers.length === 1)
    expect(tg.answers[0]?.text).toBe('Сначала нажми «Изменить» и пришли текст отклика')
    await new Promise((r) => setTimeout(r, 300))
    expect(await db.select().from(outbox)).toHaveLength(0)
    expect(fake.bids).toHaveLength(0)
    const [t] = await db.select().from(task).where(eq(task.entityId, id))
    expect(t?.state).toBe('open')
  })
})
