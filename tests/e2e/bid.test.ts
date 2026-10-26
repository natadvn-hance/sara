import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { formatRub } from '@sara/shared'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { deal, event, lead, outbox, question, task } from '../../apps/core/src/db/schema'
import { resumeQueuedOutbox } from '../../apps/core/src/leads/outbox'
import { TEXTS } from '../../apps/core/src/notify/cards'
import { setSetting } from '../../apps/core/src/settings/store'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

// The bid path after the review of 25.10.2026: the service price (K2), the node's refusals (B1), the fee
// pressed (B2), a second press after a give-back (B3), unsure bids found later (B4) and the small ones (M1, M6, M8).
const ROOT = resolve(import.meta.dirname, '../..')
const FIT = '{"verdict":"fit","reason":"Нужен сайт","tags":["сайт"],"confidence":0.9}'
const BODY = 'Понимаю задачу.\n\nКогда запуск?'
const TITLE = 'Сайт для стоматологической клиники'
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let n = 0
let analystPrice: number | null = 30000
const orderId = () => `${Date.now()}${n++}`

async function until(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}
const settle = () => new Promise((r) => setTimeout(r, 800))
const cards = () => tg.sent.filter((m) => m.reply_markup)
const button = (action: string, m = cards().at(-1)) =>
  m?.reply_markup?.inline_keyboard.flat().find((b) => b.callback_data.endsWith(`:${action}`))
const said = (t: string) => tg.sent.some((m) => m.text === t)
const leadOf = async (id: string) => (await db.select().from(lead).where(eq(lead.id, id)))[0]
const taskOf = async (id: string) => (await db.select().from(task).where(eq(task.entityId, id)))[0]
const payloads = async (type: string, id: string) =>
  (
    await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, type), eq(event.entityId, id)))
  ).map((e) => e.payload)
async function count(type: string): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(event)
    .where(eq(event.type, type))
  return r[0]?.n ?? 0
}
/** An order and its card; the press on «Откликнуться» is left to the test. */
async function cardFor(more: Parameters<FakeProfi['emitOrder']>[0] = {}, id = orderId()) {
  const before = cards().length
  await fake.emitOrder({ order_id: id, ...more })
  await until(() => cards().length === before + 1)
  return id
}
const press = (action = 'bid') => tg.pushPress(111, button(action)?.callback_data ?? '')
/** Sara's question for the price, once it went out: its message id. */
async function priceAsk(): Promise<number> {
  const asked = async () =>
    (await db.select().from(question).where(eq(question.kind, 'edit_price'))).find(
      (q) => q.telegramMessageId,
    )
  await until(async () => !!(await asked()) && said(TEXTS.askPrice(TITLE)))
  return (await asked())?.telegramMessageId ?? -1
}

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
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-bid-')),
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
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({ analyst: analystAnswer(BODY, analystPrice) }),
      }),
      retryDelaysMs: [50, 50],
      busyRetry: { delayMs: 50, tries: 2 },
      reconcileDelaysMs: [200, 200],
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
  analystPrice = 30000
  await resetDb(db)
  tg.sent.length = 0
  tg.edited.length = 0
  tg.answers.length = 0
  fake.bids.length = 0
  fake.setFee(null)
  fake.refuseNext('INTERNAL', 0)
  fake.failAcks(0)
  fake.onSubmit(null)
  fake.delayHealth(0)
  fake.setHealth({ balance_rub: 5000 })
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'outbound.bids', true, 'boris')
  await setSetting(db, 'pipeline.leads', true, 'boris')
  await setSetting(db, 'cards.quiet_hours', null, 'boris')
})

describe('the service price (K2)', () => {
  it('FR-LEAD-8: «Откликнуться» without a service price asks for it, keeps the card and records nothing', async () => {
    analystPrice = null
    const id = await cardFor()
    press()
    await until(() => tg.answers.length === 1)
    expect(tg.answers[0]?.text).toBe(TEXTS.waitingPrice)
    await until(() => said(TEXTS.askPrice(TITLE)))
    await settle()
    expect(await db.select().from(outbox)).toHaveLength(0)
    expect(fake.bids).toHaveLength(0)
    expect((await taskOf(id))?.state).toBe('open')
  })

  it('FR-LEAD-8: the price in reply is saved and journaled, and the next press bids with it', async () => {
    analystPrice = null
    const id = await cardFor()
    press()
    tg.pushText(111, '5 000', await priceAsk())
    await until(() => said(TEXTS.priceSaved(TITLE)))
    expect(await leadOf(id)).toMatchObject({
      draftPriceRub: 5000,
      draftText: `Ирина, добрый день!\n\n${BODY}`,
    })
    expect(await payloads('draft.priced', id)).toEqual([
      { before: null, after: 5000, voice: false },
    ])
    expect(await payloads('draft.edited', id)).toEqual([])
    await until(() => cards().length === 2)
    press()
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    expect(fake.bids[0]).toMatchObject({ order_id: id, price_rub: 5000, max_fee_rub: 210 })
  })

  it('FR-LEAD-8: a reply to the price question without a price changes nothing and asks again', async () => {
    analystPrice = null
    const id = await cardFor()
    press()
    tg.pushText(111, 'пять тысяч', await priceAsk())
    await until(() => said(TEXTS.priceNotFound))
    expect(await leadOf(id)).toMatchObject({
      draftPriceRub: null,
      draftText: `Ирина, добрый день!\n\n${BODY}`,
    })
    const [q] = await db.select().from(question).where(eq(question.kind, 'edit_price'))
    expect(q?.answeredAt).toBeNull()
  })

  it('FR-LEAD-7: «Изменить» takes a new text with the price on its own line', async () => {
    const id = await cardFor()
    tg.pushPress(111, button('edit')?.callback_data ?? '')
    await until(async () =>
      (await db.select().from(question).where(eq(question.kind, 'edit_draft'))).some(
        (q) => q.telegramMessageId,
      ),
    )
    tg.pushText(111, 'Сделаем за неделю.\n\nцена 7 000')
    await until(() => said(TEXTS.draftAndPriceSaved(TITLE)))
    expect(await leadOf(id)).toMatchObject({
      draftText: 'Ирина, добрый день!\n\nСделаем за неделю.',
      draftPriceRub: 7000,
    })
    expect(await payloads('draft.priced', id)).toEqual([
      { before: 30000, after: 7000, voice: false },
    ])
    expect(await payloads('draft.edited', id)).toHaveLength(1)
  })
})

describe('the node refuses (B1)', () => {
  it('FR-LEAD-8: a refusal gives the order back with its own words, and the next press bids', async () => {
    const id = await cardFor()
    fake.refuseNext('NO_MONEY')
    press()
    await until(() => said(TEXTS.bidRefused(TITLE, 'NO_MONEY')))
    await until(() => cards().length === 2)
    expect(await db.select().from(outbox)).toHaveLength(0)
    expect((await taskOf(id))?.state).toBe('open')
    expect((await leadOf(id))?.status).toBe('queued')
    expect(await payloads('bid.failed', id)).toEqual([{ reason: 'NO_MONEY', given_back: true }])
    press()
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    expect(fake.bids).toHaveLength(1)
  })

  it('FR-LEAD-8: a busy account tab is tried again, not failed', async () => {
    await cardFor()
    fake.refuseNext('RATE_LIMITED', 2)
    press()
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    expect(fake.bids).toHaveLength(1)
    expect(tg.sent.some((m) => m.text.includes('не ушёл'))).toBe(false)
  })

  it('FR-LEAD-8: a tab busy through all the tries gives the order back', async () => {
    const id = await cardFor()
    fake.refuseNext('RATE_LIMITED', 99)
    press()
    await until(() => said(TEXTS.bidRefused(TITLE, 'RATE_LIMITED')))
    expect((await taskOf(id))?.state).toBe('open')
    expect(fake.bids).toHaveLength(0)
  })

  it('FR-LEAD-8: a closed order says so and brings no card', async () => {
    const id = await cardFor()
    fake.refuseNext('ORDER_CLOSED')
    press()
    await until(() => said(TEXTS.bidRefused(TITLE, 'ORDER_CLOSED')))
    await settle()
    expect(cards()).toHaveLength(1)
    expect((await taskOf(id))?.state).toBe('resolved')
    const [o] = await db.select().from(outbox)
    expect(o).toMatchObject({ state: 'failed', errorClass: 'ORDER_CLOSED' })
  })

  it('FR-LEAD-5: a press that ended ORDER_CLOSED closes the card in place: the closed line, no buttons', async () => {
    const id = await cardFor()
    const card = cards().at(-1)
    fake.refuseNext('ORDER_CLOSED')
    press()
    await until(() => said(TEXTS.bidRefused(TITLE, 'ORDER_CLOSED')))
    await until(() => tg.edited.length === 1)
    expect(tg.edited[0]).toMatchObject({
      message_id: card?.message_id,
      reply_markup: { inline_keyboard: [] },
    })
    expect(tg.edited[0]?.text).toContain(TEXTS.closedOnSite)
    // What Boris pressed stays: the task is his decision, the bid is the failed one.
    expect(await taskOf(id)).toMatchObject({ state: 'resolved', resolution: 'bid' })
    expect(await payloads('lead.closed_on_site', id)).toEqual([{ via: 'press' }])
    expect((await leadOf(id))?.status).toBe('closed')
  })

  it('FR-LEAD-8: a bid refused for another reason leaves the card as it is', async () => {
    await cardFor()
    fake.refuseNext('NO_MONEY')
    press()
    await until(() => said(TEXTS.bidRefused(TITLE, 'NO_MONEY')))
    await settle()
    expect(tg.edited).toHaveLength(0)
  })
})

describe('the fee Boris pressed (B2)', () => {
  it('FR-LEAD-9: an unknown fee is read from the page at the press, and the card comes again with it', async () => {
    // The page could not be read when the order came: the card knows no fee.
    const id = orderId()
    fake.setOrderPage(id, { fail: 'RATE_LIMITED' })
    await cardFor({ bid_price_rub: 0 }, id)
    expect(button('bid')?.text).toBe('Откликнуться')
    fake.setOrderPage(id, { bid_price_rub: 230 })
    press()
    await until(() => tg.answers.length === 1)
    expect(tg.answers[0]?.text).toBe(TEXTS.feeChecking)
    await until(() => cards().length === 2)
    expect(button('bid')?.text).toBe(`Откликнуться за ${formatRub(230)}`)
    expect(await db.select().from(outbox)).toHaveLength(0)
    expect((await leadOf(id))?.bidPriceRub).toBe(230)
  })

  it('FR-LEAD-9: a fee still unknown at the press sends nothing and says to bid by hand', async () => {
    const id = orderId()
    fake.setOrderPage(id, { fail: 'RATE_LIMITED' })
    await cardFor({ bid_price_rub: 0 }, id)
    press()
    await until(() => said(TEXTS.feeUnknown(TITLE)))
    expect(await db.select().from(outbox)).toHaveLength(0)
    expect(fake.bids).toHaveLength(0)
    expect((await taskOf(id))?.state).toBe('open')
  })

  it('FR-LEAD-9: a form asking more while the page shows the same fee ends without a card that cannot go', async () => {
    const id = await cardFor()
    fake.refuseNext('PRICE_CHANGED')
    press()
    await until(() => said(TEXTS.bidDearer(TITLE, 210, null)))
    await settle()
    expect(cards()).toHaveLength(1)
    const [o] = await db.select().from(outbox)
    expect(o).toMatchObject({ state: 'failed', errorClass: 'PRICE_CHANGED' })
    expect((await taskOf(id))?.state).toBe('resolved')
  })

  it('FR-LEAD-9: a bid dearer than the card comes back with the new fee, and the next press pays it', async () => {
    const id = await cardFor()
    fake.setFee(250)
    press()
    await until(() => said(TEXTS.bidDearer(TITLE, 210, 250)))
    await until(() => cards().length === 2)
    expect(button('bid')?.text).toBe(`Откликнуться за ${formatRub(250)}`)
    expect((await leadOf(id))?.bidPriceRub).toBe(250)
    expect(fake.bids).toHaveLength(0)
    press()
    await until(() => said(TEXTS.bidSent(TITLE, 250)))
    expect(fake.bids[0]?.max_fee_rub).toBe(250)
  })

  it('FR-LEAD-9: ✅ says what was spent, not the fee on the card', async () => {
    await cardFor()
    fake.setFee(190)
    press()
    await until(() => said(TEXTS.bidSent(TITLE, 190)))
  })
})

describe('a second press after a give-back (B3) and the pause in the delivery (M1)', () => {
  it('FR-OPS-1: a pause set while the bid waits gives it back, and after it the next press bids', async () => {
    const id = await cardFor()
    // The tab is busy; meanwhile Boris pauses the bids.
    fake.refuseNext('RATE_LIMITED', 1)
    fake.onSubmit(async () => {
      fake.onSubmit(null)
      await setSetting(db, 'outbound.bids', false, 'boris')
    })
    press()
    await until(() => said(TEXTS.bidsPaused))
    await until(() => cards().length === 2)
    expect(fake.bids).toHaveLength(0)
    expect((await taskOf(id))?.state).toBe('open')
    await setSetting(db, 'outbound.bids', true, 'boris')
    press()
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    expect(fake.bids).toHaveLength(1)
    const [o] = await db.select().from(outbox)
    expect(o?.state).toBe('confirmed')
  })

  it('NFR-REL-3: a bid queued over an hour before the start is given back, not sent', async () => {
    const id = await cardFor()
    const [l] = await db.select().from(lead).where(eq(lead.id, id))
    const t = await taskOf(id)
    await db
      .update(task)
      .set({ state: 'resolved', resolution: 'bid' })
      .where(eq(task.id, t?.id ?? ''))
    await db.insert(outbox).values({
      id: '01a16440-0000-7000-8000-000000000002',
      kind: 'bid',
      idempotencyKey: `bid:${id}`,
      payload: {
        leadId: id,
        accountId: 'hance-marketing',
        text: 'Добрый день!',
        correlationId: l?.correlationId,
        title: l?.title,
        priceRub: 210,
        servicePriceRub: 30000,
        taskId: t?.id,
      },
      createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    })
    await resumeQueuedOutbox(db)
    await until(() => said(TEXTS.bidStale(TITLE)))
    expect(await db.select().from(outbox)).toHaveLength(0)
    expect((await taskOf(id))?.state).toBe('open')
    await settle()
    expect(fake.bids).toHaveLength(0)
  })
})

describe('unsure bids and bids already there (B4, M6)', () => {
  it('NFR-REL-4: an unsure bid found on the order later is recorded with its spend and its deal', async () => {
    const id = await cardFor()
    fake.failAcks(10)
    press()
    await until(() => said(TEXTS.bidUncertain))
    await until(() => said(TEXTS.bidFoundLater(TITLE, 210)), 10000)
    const [o] = await db.select().from(outbox)
    expect(o?.state).toBe('confirmed')
    expect(await payloads('spend.recorded', id)).toEqual([
      { amount_rub: 210, balance_after_rub: null, found_later: true },
    ])
    expect(await db.select().from(deal).where(eq(deal.leadId, id))).toHaveLength(1)
    expect(fake.bids).toHaveLength(1)
  })

  it('NFR-REL-4: a bid Boris already made by hand is reported as there, with no spend and no deal', async () => {
    const id = await cardFor()
    fake.markBid(id)
    press()
    await until(() => said(TEXTS.bidAlreadyThere(TITLE)))
    expect(tg.sent.some((m) => m.text.startsWith('✅'))).toBe(false)
    expect(await count('bid.sent')).toBe(0)
    expect(await count('spend.recorded')).toBe(0)
    expect(await db.select().from(deal).where(eq(deal.leadId, id))).toHaveLength(0)
    expect((await leadOf(id))?.status).toBe('bid_sent')
  })
})

describe('the text at the press (M8)', () => {
  it('FR-LEAD-8: the bid carries the text as it is when the press is recorded', async () => {
    const id = await cardFor()
    fake.delayHealth(700)
    press()
    // A new text lands while the press waits for the wallet.
    await new Promise((r) => setTimeout(r, 200))
    await db
      .update(lead)
      .set({ draftText: 'Ирина, добрый день!\n\nДругой текст.' })
      .where(eq(lead.id, id))
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    expect(fake.bids[0]?.text).toBe('Ирина, добрый день!\n\nДругой текст.')
  }, 20000)
})
