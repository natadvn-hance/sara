import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { and, asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { event, lead, task } from '../../apps/core/src/db/schema'
import { seedDirection } from '../../apps/core/src/direction/store'
import { dailySummary } from '../../apps/core/src/learning/summary'
import { setSetting } from '../../apps/core/src/settings/store'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { summaryTime } from '../../apps/core/test/helpers/learning'
import { scorerAnswer } from '../../apps/core/test/helpers/scorer'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

const ROOT = resolve(import.meta.dirname, '../..')
const FIT = { verdict: 'fit', reason: 'Нужен сайт', tags: ['сайт'], confidence: 0.9 }
const REJECT = { verdict: 'reject', reason: 'Не наша сфера', tags: [], confidence: 0.9 }
const NBSP = ' '
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let log: string
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
const settle = () => new Promise((r) => setTimeout(r, 400))
const cards = () => tg.sent.filter((m) => m.reply_markup)
/** Lead cards only: the daily summary has buttons too. */
const leadCards = () =>
  cards().filter((m) =>
    m.reply_markup?.inline_keyboard.flat().some((b) => b.callback_data.endsWith(':bid')),
  )
const leadOf = async (id: string) => (await db.select().from(lead).where(eq(lead.id, id)))[0]
const journal = async (id: string) =>
  db
    .select({ type: event.type, payload: event.payload })
    .from(event)
    .where(and(eq(event.entityId, id), eq(event.entityKind, 'lead')))
    .orderBy(asc(event.id))
/** The input each model call of this role got (the fake Claude logs its stdin). */
const inputsOf = (role: string): string[] =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args: string[]; stdin: string })
    .filter((c) => c.args.some((a) => a.endsWith(`roles/${role}/role.md`)))
    .map((c) => c.stdin)

const CLIENT = {
  name: 'Ирина',
  on_profi_since: 'На Профи.ру с 7 сентября 2020',
  phone_verified: true,
  reviews: { positive: 3, negative: 1 },
  review_tags: ['Перестала отвечать'],
}
/** An order as the board shows it: the fee is not known, 0. */
const BOARD = { bid_price_rub: 0, client_name: 'Ирина', text: 'Нужен сайт для клиники' }

beforeAll(async () => {
  tg = await createFakeTelegram()
  log = join(await mkdtemp(join(tmpdir(), 'e2e-snippet-log-')), 'claude.log')
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
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-snippet-')),
      port: 0,
      profiMcpUrl: fake.url,
      nodeToken: 'node-tok',
      permitSecret: 'permit',
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      telegramApiRoot: tg.apiRoot,
    },
    {
      claudeEnv: () => ({
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify(byRole),
        FAKE_CLAUDE_ARGS_LOG: log,
      }),
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
  byRole = { sorter: FIT, scorer: scorerAnswer(70), analyst: analystAnswer('Понимаю задачу.') }
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  tg.sent.length = 0
  tg.answers.length = 0
  fake.orderReads.length = 0
  writeFileSync(log, '')
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'pipeline.leads', true, 'boris')
  await setSetting(db, 'outbound.bids', true, 'boris')
})

describe('the page of an order is read only for a lead worth it', () => {
  it('FR-LEAD-2: an order the Sorter rejected never has its page read', async () => {
    byRole = { ...byRole, sorter: REJECT }
    const id = orderId()
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(async () => (await leadOf(id))?.status === 'sorted_out')
    await settle()
    expect(fake.orderReads).toEqual([])
  })

  it('FR-LEAD-2: an order the Scorer dropped never has its page read', async () => {
    byRole = { ...byRole, scorer: scorerAnswer(30) }
    const id = orderId()
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(async () => (await leadOf(id))?.status === 'scored_out')
    await settle()
    expect(fake.orderReads).toEqual([])
    expect(cards()).toHaveLength(0)
  })

  it('FR-LEAD-5: a shown order has its page read once, after the Scorer and before the Analyst', async () => {
    const id = orderId()
    fake.setOrderPage(id, { bid_price_rub: 145, client_info: CLIENT })
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(() => cards().length === 1)
    expect(fake.orderReads).toEqual([id])
    const types = (await journal(id)).map((e) => e.type)
    expect(types.indexOf('lead.scored')).toBeGreaterThan(-1)
    expect(types.indexOf('lead.page_read')).toBeGreaterThan(types.indexOf('lead.scored'))
    expect(types.indexOf('lead.drafted')).toBeGreaterThan(types.indexOf('lead.page_read'))
    expect((await journal(id)).find((e) => e.type === 'lead.page_read')?.payload).toEqual({
      ok: true,
      open: true,
      has_bid: false,
      fee_rub: 145,
      client_info: true,
      error: null,
    })
  })
})

describe('what the page adds to the lead', () => {
  it('FR-LEAD-5: the fee and the client info of the page are on the lead and the card names the fee', async () => {
    const id = orderId()
    fake.setOrderPage(id, { bid_price_rub: 145, client_info: CLIENT })
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(() => cards().length === 1)
    expect(await leadOf(id)).toMatchObject({
      bidPriceRub: 145,
      clientInfo: CLIENT,
      clientName: 'Ирина',
      text: 'Нужен сайт для клиники',
    })
    expect(cards()[0]?.text).toContain(`отклик 145${NBSP}₽`)
    expect(
      cards()[0]
        ?.reply_markup?.inline_keyboard.flat()
        .map((b) => b.text),
    ).toContain(`Откликнуться за 145${NBSP}₽`)
  })

  it('FR-LEAD-5: the client name and the text the board lacked come from the page, what the board had is kept', async () => {
    const empty = orderId()
    fake.setOrderPage(empty, { client_name: 'Анна', text: 'Полный текст страницы' })
    await fake.emitOrder({ order_id: empty, bid_price_rub: 0, client_name: '', text: '' })
    await until(() => cards().length === 1)
    expect(await leadOf(empty)).toMatchObject({ clientName: 'Анна', text: 'Полный текст страницы' })

    const full = orderId()
    fake.setOrderPage(full, { client_name: 'Чужая', text: 'Другой текст' })
    await fake.emitOrder({ order_id: full, ...BOARD })
    await until(() => cards().length === 2)
    expect(await leadOf(full)).toMatchObject({
      clientName: 'Ирина',
      text: 'Нужен сайт для клиники',
    })
  })

  it('FR-LEAD-6: the Analyst gets the fuller order: the page text and the client facts, never the name', async () => {
    const id = orderId()
    fake.setOrderPage(id, { text: 'Полный текст страницы', client_info: CLIENT })
    await fake.emitOrder({ order_id: id, bid_price_rub: 0, client_name: '', text: '' })
    await until(() => cards().length === 1)
    const [input] = inputsOf('analyst')
    expect(input).toContain('Полный текст страницы')
    expect(input).toContain('На Профи.ру с 7 сентября 2020')
    expect(input).toContain('номер подтверждён')
    expect(input).toContain('3 хороших, 1 плохой')
    expect(input).toContain('Перестала отвечать')
    expect(input).not.toContain('Ирина')
    // The Sorter and the Scorer judged by the board alone.
    expect(inputsOf('sorter')[0]).not.toContain('Полный текст страницы')
  })
})

describe('an order the page shows as not to offer', () => {
  it('FR-LEAD-5: a closed order is marked closed, no card and no Analyst call', async () => {
    const id = orderId()
    fake.setOrderPage(id, { open: false })
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(async () => (await leadOf(id))?.status === 'closed')
    await settle()
    expect(cards()).toHaveLength(0)
    expect(inputsOf('analyst')).toHaveLength(0)
    expect((await journal(id)).map((e) => e.type)).toContain('lead.page_read')
  })

  it('FR-LEAD-5: an order this account already bid on is marked bid_already, no card', async () => {
    const id = orderId()
    fake.setOrderPage(id, { has_bid: true })
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(async () => (await leadOf(id))?.status === 'bid_already')
    await settle()
    expect(cards()).toHaveLength(0)
    expect(inputsOf('analyst')).toHaveLength(0)
  })
})

describe('what counts as a page that was read', () => {
  it("FR-LEAD-5: an answer from the node's store, not from the page, is a page not read, and the card still comes", async () => {
    const id = orderId()
    // The tab may not move: the node answers with what it stored (open: true, nothing checked).
    fake.setOrderPage(id, { from_page: false })
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(() => cards().length === 1)
    expect((await journal(id)).find((e) => e.type === 'lead.page_read')?.payload).toEqual({
      ok: false,
      open: null,
      has_bid: null,
      fee_rub: null,
      client_info: false,
      error: 'NOT_READ',
    })
    expect(await leadOf(id)).toMatchObject({ bidPriceRub: 0, clientInfo: null, status: 'queued' })
  })

  it('FR-LEAD-5: an old node that does not say where its numbers come from is not trusted as a read page', async () => {
    const id = orderId()
    fake.setOrderPage(id, { from_page: undefined })
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(() => cards().length === 1)
    expect((await journal(id)).find((e) => e.type === 'lead.page_read')?.payload).toMatchObject({
      ok: false,
      error: 'NOT_READ',
    })
  })

  it('FR-LEAD-5: an order we already bid on is bid_already even when its page shows no form', async () => {
    const id = orderId()
    fake.setOrderPage(id, { open: false, has_bid: true })
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(async () => (await leadOf(id))?.status === 'bid_already')
  })

  it('FR-LEAD-5: a closed order keeps its Sorter verdict in the journal', async () => {
    const id = orderId()
    fake.setOrderPage(id, { open: false })
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(async () => (await leadOf(id))?.status === 'closed')
    const sorted = (await journal(id)).filter((e) => e.type === 'lead.sorted')
    expect(sorted.map((e) => e.payload)).toEqual([{ verdict: 'fit', reason: 'Нужен сайт' }])
  })

  it('FR-LEAD-5: a fee the board knew is kept when the page gives none', async () => {
    const id = orderId()
    fake.setOrderPage(id, { bid_price_rub: 0 })
    await fake.emitOrder({ order_id: id, ...BOARD, bid_price_rub: 99 })
    await until(() => cards().length === 1)
    expect(await leadOf(id)).toMatchObject({ bidPriceRub: 99 })
    expect(cards()[0]?.text).toContain(`отклик 99${NBSP}₽`)
  })
})

describe('a page that could not be read', () => {
  it('FR-LEAD-5: the card still comes with the board data, the fee shown as unknown', async () => {
    const id = orderId()
    fake.setOrderPage(id, { fail: 'LAYOUT_CHANGED' })
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(() => cards().length === 1)
    expect(await leadOf(id)).toMatchObject({ bidPriceRub: 0, clientInfo: null, status: 'queued' })
    // Whatever the card's words, it says the fee is unknown and names no sum.
    expect(cards()[0]?.text).toMatch(/цена.*неизвестна/)
    expect(cards()[0]?.text).not.toMatch(/отклик 0/i)
    expect(
      cards()[0]
        ?.reply_markup?.inline_keyboard.flat()
        .map((b) => b.text),
    ).toContain('Откликнуться')
    expect((await journal(id)).find((e) => e.type === 'lead.page_read')?.payload).toEqual({
      ok: false,
      open: null,
      has_bid: null,
      fee_rub: null,
      client_info: false,
      error: 'LAYOUT_CHANGED',
    })
  })

  it('FR-LEAD-5: a dead session at the page read does not hold the card back', async () => {
    const id = orderId()
    fake.setOrderPage(id, { fail: 'SESSION_DEAD' })
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(() => cards().length === 1)
    expect(await leadOf(id)).toMatchObject({ bidPriceRub: 0, status: 'queued' })
  })
})

describe('«Взял бы» on an order the Scorer dropped reads its page too', () => {
  /** Drops an order, brings the daily summary and presses «Взял бы» on it. */
  async function wantDropped(id: string) {
    byRole = { ...byRole, scorer: scorerAnswer(50) }
    await fake.emitOrder({ order_id: id, ...BOARD })
    await until(async () => (await leadOf(id))?.status === 'scored_out')
    expect(fake.orderReads).toEqual([])
    await dailySummary({ db: app.db, notifier: app.bot.notifier }, summaryTime())
    await until(() => tg.sent.some((m) => m.text.startsWith('Сегодня отсеяла')))
    const summary = tg.sent.find((m) => m.text.startsWith('Сегодня отсеяла'))
    tg.pushPress(111, summary?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? '')
  }

  it('FR-LEAD-5: the card of a wanted order has the fee and the client from its page', async () => {
    const id = orderId()
    fake.setOrderPage(id, { bid_price_rub: 145, client_info: CLIENT })
    await wantDropped(id)
    await until(() => cards().some((m) => m.text.includes('Черновик отклика')))
    expect(fake.orderReads).toEqual([id])
    expect(await leadOf(id)).toMatchObject({ bidPriceRub: 145, clientInfo: CLIENT })
    expect(cards().at(-1)?.text).toContain(`отклик 145${NBSP}₽`)
    expect(inputsOf('analyst')[0]).toContain('На Профи.ру с 7 сентября 2020')
  })

  it('FR-LEAD-5: a wanted order whose page could not be read still comes as a card, the fee unknown', async () => {
    const id = orderId()
    fake.setOrderPage(id, { fail: 'LAYOUT_CHANGED' })
    await wantDropped(id)
    await until(() => leadCards().length === 1)
    expect(fake.orderReads).toEqual([id])
    expect(leadCards()[0]?.text).toMatch(/цена.*неизвестна/)
    expect(await leadOf(id)).toMatchObject({ bidPriceRub: 0 })
  })

  it('FR-LEAD-5: a wanted order that is closed by now is not sent as a card, Boris is told', async () => {
    const id = orderId()
    fake.setOrderPage(id, { open: false })
    await wantDropped(id)
    await until(() => tg.sent.some((m) => m.text === 'Заявка уже закрыта, карточку не присылаю.'))
    expect(leadCards()).toHaveLength(0)
    expect(inputsOf('analyst')).toHaveLength(0)
    expect(await leadOf(id)).toMatchObject({ status: 'closed' })
    const tasks = await db.select().from(task).where(eq(task.entityId, id))
    expect(tasks.filter((t) => t.kind === 'lead_decision').map((t) => t.state)).toEqual([
      'resolved',
    ])
  })

  it('FR-LEAD-5: a wanted order this account already bid on is not sent as a card either', async () => {
    const id = orderId()
    fake.setOrderPage(id, { has_bid: true })
    await wantDropped(id)
    await until(() =>
      tg.sent.some((m) => m.text === 'На эту заявку уже есть отклик, карточку не присылаю.'),
    )
    expect(leadCards()).toHaveLength(0)
    expect(await leadOf(id)).toMatchObject({ status: 'bid_already' })
  })
})
