import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { event, lead, task } from '../../apps/core/src/db/schema'
import { seedDirection } from '../../apps/core/src/direction/store'
import { TEXTS } from '../../apps/core/src/notify/cards'
import { setSetting } from '../../apps/core/src/settings/store'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { scorerAnswer } from '../../apps/core/test/helpers/scorer'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

// FR-LEAD-5: a card that waits for Boris is looked at again; when its order closed on Profi.ru the card loses its
// buttons. The job is driven by hand (tick with a time), so the tests run at any hour of the day.
const ROOT = resolve(import.meta.dirname, '../..')
const FIT = { verdict: 'fit', reason: 'Нужен сайт', tags: ['сайт'], confidence: 0.9 }
const TITLE = 'Сайт для стоматологической клиники'
const BOARD = { bid_price_rub: 0, client_name: 'Ирина', text: 'Нужен сайт для клиники' }
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let n = 0
const orderId = () => `${Date.now()}${n++}`

async function until(cond: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}
const settle = () => new Promise((r) => setTimeout(r, 500))

const MSK = 3 * 3600_000
/** The Moscow day of `d` shifted by `days`, at `h`:`m` Moscow time, as a real instant. */
const atMsk = (d: Date, days: number, h: number, m = 0) => {
  const x = new Date(d.getTime() + MSK)
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate() + days, h, m) - MSK)
}
const plus = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000)
/**
 * The first pass of a test: more than an hour after the card, between 9:00 and 21:00 Moscow time, so an hour more
 * (the next pass) still lies in the recheck hours. Else the next 9:30.
 */
function first(): Date {
  const t = plus(new Date(), 61)
  const h = new Date(t.getTime() + MSK).getUTCHours()
  return h >= 9 && h < 21 ? t : atMsk(t, h < 9 ? 0 : 1, 9, 30)
}

/** Lead cards only: the daily summary has buttons too. */
const leadCards = () =>
  tg.sent.filter((m) =>
    m.reply_markup?.inline_keyboard.flat().some((b) => b.callback_data.endsWith(':bid')),
  )
const button = (action: string, m = leadCards().at(-1)) =>
  m?.reply_markup?.inline_keyboard.flat().find((b) => b.callback_data.endsWith(`:${action}`))
const press = (action: string) => tg.pushPress(111, button(action)?.callback_data ?? '')
const said = (t: string) => tg.sent.some((m) => m.text === t)
const leadOf = async (id: string) => (await db.select().from(lead).where(eq(lead.id, id)))[0]
const taskOf = async (id: string) => (await db.select().from(task).where(eq(task.entityId, id)))[0]
const payloads = async (type: string, id: string) =>
  (
    await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, type), eq(event.entityId, id)))
      .orderBy(event.recordedAt, event.id)
  ).map((e) => e.payload)
const actorsOf = async (type: string, id: string) =>
  (
    await db
      .select({ actor: event.actor })
      .from(event)
      .where(and(eq(event.type, type), eq(event.entityId, id)))
  ).map((e) => e.actor)

/** An order that came, passed the Sorter and the Scorer and reached Boris as a card. */
async function shownCard(): Promise<{ id: string; taskId: string; messageId: number }> {
  const id = orderId()
  const before = leadCards().length
  fake.setOrderPage(id, { bid_price_rub: 145 })
  await fake.emitOrder({ order_id: id, ...BOARD })
  await until(() => leadCards().length === before + 1)
  // The card is in the chat before the task keeps its message number and the journal the moment it went out.
  await until(async () => (await taskOf(id))?.telegramMessageId != null)
  const t = await taskOf(id)
  return { id, taskId: t?.id ?? '', messageId: leadCards().at(-1)?.message_id ?? -1 }
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
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-recheck-')),
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
          sorter: FIT,
          scorer: scorerAnswer(70),
          analyst: analystAnswer('Понимаю задачу.\n\nКогда запуск?', 30000),
        }),
      }),
      retryDelaysMs: [50, 50],
      busyRetry: { delayMs: 50, tries: 2 },
      reconcileDelaysMs: [200, 200],
      learningTickMs: 3_600_000,
      // The recheck is driven by the tests: it never ticks by itself here.
      recheckTickMs: 3_600_000,
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
  await seedDirection(db, 'hance-marketing')
  tg.sent.length = 0
  tg.edited.length = 0
  tg.answers.length = 0
  fake.bids.length = 0
  fake.orderReads.length = 0
  fake.refuseNext('INTERNAL', 0)
  fake.setHealth({ balance_rub: 5000 })
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'pipeline.leads', true, 'boris')
  await setSetting(db, 'outbound.bids', true, 'boris')
  await setSetting(db, 'cards.quiet_hours', null, 'boris')
})

describe('a waiting card is looked at again (FR-LEAD-5)', () => {
  it('FR-LEAD-5: an order still open is read again and its card is left as it is, and not again within the hour', async () => {
    const { id } = await shownCard()
    const at = first()
    const reads = fake.orderReads.length
    expect(await app.recheck.tick(at)).toEqual({ checked: 1, closed: 0, doubt: false })
    expect(fake.orderReads).toHaveLength(reads + 1)
    expect(tg.edited).toHaveLength(0)
    expect((await taskOf(id))?.state).toBe('open')
    expect((await payloads('lead.page_read', id)).at(-1)).toEqual({
      ok: true,
      open: true,
      has_bid: false,
      fee_rub: 145,
      client_info: false,
      error: null,
      via: 'recheck',
    })
    // Less than an hour after that look nothing is read; an hour after it the card is looked at again.
    expect(await app.recheck.tick(plus(at, 30))).toEqual({ checked: 0, closed: 0, doubt: false })
    expect(fake.orderReads).toHaveLength(reads + 1)
    expect(await app.recheck.tick(plus(at, 61))).toMatchObject({ checked: 1, closed: 0 })
    expect(fake.orderReads).toHaveLength(reads + 2)
    expect(tg.edited).toHaveLength(0)
  }, 60000)

  it('FR-LEAD-5: a card is not looked at before it has waited an hour', async () => {
    await shownCard()
    const reads = fake.orderReads.length
    // The card went out a moment ago, in the real clock of the run.
    expect(await app.recheck.tick(plus(new Date(), 20))).toMatchObject({ checked: 0 })
    expect(fake.orderReads).toHaveLength(reads)
  }, 60000)

  it('FR-LEAD-5: no page is read at night, from 23:00 to 9:00 Moscow time', async () => {
    const { id } = await shownCard()
    fake.setOrderPage(id, { open: false })
    const reads = fake.orderReads.length
    const day = plus(first(), 24 * 60)
    for (const [h, m] of [
      [23, 0],
      [3, 0],
      [8, 59],
    ] as const) {
      expect(await app.recheck.tick(atMsk(day, 0, h, m))).toEqual({
        checked: 0,
        closed: 0,
        doubt: false,
      })
    }
    expect(fake.orderReads).toHaveLength(reads)
    expect(tg.edited).toHaveLength(0)
    expect((await taskOf(id))?.state).toBe('open')
    // The same card, the same order, at nine in the morning.
    expect(await app.recheck.tick(atMsk(day, 0, 9, 0))).toMatchObject({ checked: 1, closed: 1 })
  }, 60000)
})

describe('a card whose order closed (FR-LEAD-5)', () => {
  it('FR-LEAD-5: every message of the card is edited: no buttons, the closed line; the task ends, the lead is closed', async () => {
    const { id, taskId, messageId } = await shownCard()
    // A reminder is a second message of the same card.
    await app.pipeline.onReminder(taskId)
    await until(() => leadCards().length === 2)
    const copy = leadCards().at(-1)?.message_id
    expect(copy).not.toBe(messageId)
    fake.setOrderPage(id, { open: false })
    expect(await app.recheck.tick(first())).toEqual({ checked: 1, closed: 1, doubt: false })
    expect(tg.edited.map((e) => e.message_id).sort()).toEqual([messageId, copy].sort())
    for (const e of tg.edited) {
      expect(e.reply_markup).toEqual({ inline_keyboard: [] })
      expect(e.parse_mode).toBe('HTML')
      expect(e.text).toContain(TEXTS.closedOnSite)
      expect(e.text).toContain(TITLE)
      // The reminder copy is closed as the plain card.
      expect(e.text).not.toContain('Заявка ждёт решения')
    }
    expect(await taskOf(id)).toMatchObject({ state: 'resolved', resolution: 'skip' })
    expect((await leadOf(id))?.status).toBe('closed')
    expect(await payloads('lead.closed_on_site', id)).toEqual([{ via: 'recheck' }])
    expect(await payloads('task.resolved', taskId)).toEqual([{ action: 'skip', reason: 'closed' }])
    // The task is decided: the next pass has nothing to read.
    const reads = fake.orderReads.length
    expect(await app.recheck.tick(plus(first(), 120))).toMatchObject({ checked: 0 })
    expect(fake.orderReads).toHaveLength(reads)
  }, 60000)

  it('FR-LEAD-5: a closed card does not come back as a reminder, and its buttons answer that it is done', async () => {
    const { id, taskId } = await shownCard()
    fake.setOrderPage(id, { open: false })
    await app.recheck.tick(first())
    const cardsBefore = leadCards().length
    await app.pipeline.onReminder(taskId)
    await app.pipeline.resendCard(taskId)
    expect(leadCards()).toHaveLength(cardsBefore)
    // A press on the old message is «Уже сделано», nothing is sent.
    const answers = tg.answers.length
    tg.pushPress(111, `t:${taskId}:bid`)
    await until(() => tg.answers.length === answers + 1)
    expect(tg.answers.at(-1)?.text).toBe(TEXTS.alreadyDone)
    expect(fake.bids).toHaveLength(0)
  }, 60000)

  it('FR-LEAD-5: a message Telegram refuses to edit does not stop the closing of the others', async () => {
    const { id, taskId, messageId } = await shownCard()
    await app.pipeline.onReminder(taskId)
    await until(() => leadCards().length === 2)
    const copy = leadCards().at(-1)?.message_id ?? -1
    // The first card message was deleted by Boris in the chat.
    tg.setEditError(messageId, 'message to edit not found')
    fake.setOrderPage(id, { open: false })
    try {
      await app.recheck.tick(first())
    } finally {
      tg.setEditError(messageId, null)
    }
    expect(tg.edited.map((e) => e.message_id)).toEqual([copy])
    expect(await taskOf(id)).toMatchObject({ state: 'resolved', resolution: 'skip' })
  }, 60000)

  it('FR-LEAD-5: a task Boris already decided is never read, and its card is left as it is', async () => {
    const decided = await shownCard()
    press('skip')
    await until(async () => (await taskOf(decided.id))?.state === 'resolved')
    const open = await shownCard()
    fake.setOrderPage(decided.id, { open: false })
    fake.setOrderPage(open.id, { open: false })
    const reads = fake.orderReads.length
    expect(await app.recheck.tick(first())).toEqual({ checked: 1, closed: 1, doubt: false })
    expect(fake.orderReads.slice(reads)).toEqual([open.id])
    expect(tg.edited.map((e) => e.message_id)).toEqual([open.messageId])
    expect(await payloads('lead.closed_on_site', decided.id)).toEqual([])
    expect((await leadOf(decided.id))?.status).toBe('skipped')
  }, 60000)

  it('FR-LEAD-5: Boris deciding while the page is being read keeps his decision: the card is not touched', async () => {
    const { id } = await shownCard()
    // The read is slow, so Boris's press lands in the middle of it.
    fake.setOrderPage(id, { open: false, delayMs: 2500 })
    const reads = fake.orderReads.length
    const pass = app.recheck.tick(first())
    await until(() => fake.orderReads.length === reads + 1)
    press('skip')
    await until(async () => (await taskOf(id))?.state === 'resolved')
    await pass
    expect(await actorsOf('task.resolved', (await taskOf(id))?.id ?? '')).toEqual(['boris'])
    expect(await taskOf(id)).toMatchObject({ state: 'resolved', resolution: 'skip' })
    expect(tg.edited).toHaveLength(0)
    expect(await payloads('lead.closed_on_site', id)).toEqual([])
    expect((await leadOf(id))?.status).toBe('skipped')
  }, 60000)
})

describe('a page that cannot be trusted (FR-LEAD-5)', () => {
  it('FR-LEAD-5: an answer from the node memory, not from the page, closes nothing and ends the pass', async () => {
    const a = await shownCard()
    const b = await shownCard()
    fake.setOrderPage(a.id, { open: false, from_page: false })
    fake.setOrderPage(b.id, { open: false })
    const reads = fake.orderReads.length
    expect(await app.recheck.tick(first())).toEqual({ checked: 0, closed: 0, doubt: false })
    // Only the oldest card was asked: the pass ended on it.
    expect(fake.orderReads.slice(reads)).toEqual([a.id])
    expect(tg.edited).toHaveLength(0)
    expect((await taskOf(a.id))?.state).toBe('open')
    expect((await taskOf(b.id))?.state).toBe('open')
    expect((await payloads('lead.page_read', a.id)).at(-1)).toEqual({
      ok: false,
      open: null,
      has_bid: null,
      fee_rub: null,
      client_info: false,
      error: 'NOT_READ',
      via: 'recheck',
    })
    expect(await payloads('lead.closed_on_site', a.id)).toEqual([])
  }, 60000)

  it('FR-LEAD-5: a read that failed (the tab is busy) is journaled with its class and closes nothing', async () => {
    const a = await shownCard()
    fake.setOrderPage(a.id, { fail: 'RATE_LIMITED' })
    expect(await app.recheck.tick(first())).toEqual({ checked: 0, closed: 0, doubt: false })
    expect((await payloads('lead.page_read', a.id)).at(-1)).toMatchObject({
      ok: false,
      error: 'RATE_LIMITED',
      via: 'recheck',
    })
    expect(tg.edited).toHaveLength(0)
    expect((await taskOf(a.id))?.state).toBe('open')
  }, 60000)

  it('FR-LEAD-5: when most of the checked cards look closed, none is closed and Boris is told once a day', async () => {
    const cards = [await shownCard(), await shownCard(), await shownCard()]
    for (const c of cards) fake.setOrderPage(c.id, { open: false })
    const at = first()
    expect(await app.recheck.tick(at)).toEqual({ checked: 3, closed: 0, doubt: true })
    await until(() => said(TEXTS.recheckDoubt(3, 3)))
    expect(tg.edited).toHaveLength(0)
    for (const c of cards) expect((await taskOf(c.id))?.state).toBe('open')
    const warnings = () => tg.sent.filter((m) => m.text === TEXTS.recheckDoubt(3, 3))
    expect(warnings()).toHaveLength(1)
    expect(await db.select().from(event).where(eq(event.type, 'lead.recheck_doubt'))).toHaveLength(
      1,
    )
    // An hour later they look closed again: still nothing closed, no second warning.
    expect(await app.recheck.tick(plus(at, 61))).toEqual({ checked: 3, closed: 0, doubt: true })
    await settle()
    expect(warnings()).toHaveLength(1)
    expect(tg.edited).toHaveLength(0)
    // The next day Boris is told again.
    expect(await app.recheck.tick(plus(at, 25 * 60))).toMatchObject({ doubt: true })
    await until(() => warnings().length === 2)
  }, 90000)
})

describe('a bid that ended ORDER_CLOSED (FR-LEAD-5)', () => {
  it('FR-LEAD-5: the card of the order is edited in place, and Boris is told as before', async () => {
    const { id, messageId } = await shownCard()
    fake.refuseNext('ORDER_CLOSED')
    press('bid')
    await until(() => said(TEXTS.bidRefused(TITLE, 'ORDER_CLOSED')))
    await until(() => tg.edited.length === 1)
    expect(tg.edited[0]).toMatchObject({
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    })
    expect(tg.edited[0]?.text).toContain(TEXTS.closedOnSite)
    // What Boris pressed stays his decision; the lead is closed all the same.
    expect(await taskOf(id)).toMatchObject({ state: 'resolved', resolution: 'bid' })
    expect((await leadOf(id))?.status).toBe('closed')
    expect(await payloads('lead.closed_on_site', id)).toEqual([{ via: 'press' }])
    await settle()
    expect(leadCards()).toHaveLength(1)
  }, 60000)
})
