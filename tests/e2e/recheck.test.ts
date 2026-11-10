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
const said = (t: string) => tg.sent.some((m) => m.text === t) || tg.edited.some((m) => m.text === t)
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

/**
 * An order that came, passed the Sorter and the Scorer and reached Boris as a card. The board saw it an hour before
 * the first pass (`first()`), so at that pass it is a fresh order whatever the hour of the run: looked at every 15
 * minutes (FR-LEAD-5).
 */
async function shownCard(): Promise<{ id: string; taskId: string; messageId: number }> {
  const id = orderId()
  const before = leadCards().length
  fake.setOrderPage(id, { bid_price_rub: 145 })
  await fake.emitOrder({ order_id: id, ...BOARD, seen_at: plus(first(), -60).toISOString() })
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
  it('FR-LEAD-5: an order still open is read again and its card is left as it is, and not again within 15 minutes', async () => {
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
    // A fresh order: less than 15 minutes after that look nothing is read; then the card is looked at again.
    expect(await app.recheck.tick(plus(at, 10))).toEqual({ checked: 0, closed: 0, doubt: false })
    expect(fake.orderReads).toHaveLength(reads + 1)
    expect(await app.recheck.tick(plus(at, 16))).toMatchObject({ checked: 1, closed: 0 })
    expect(fake.orderReads).toHaveLength(reads + 2)
    expect(tg.edited).toHaveLength(0)
  }, 60000)

  it('FR-LEAD-5: a card is not looked at before it has waited 15 minutes', async () => {
    await shownCard()
    const reads = fake.orderReads.length
    // The card went out a moment ago, in the real clock of the run.
    expect(await app.recheck.tick(plus(new Date(), 10))).toMatchObject({ checked: 0 })
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
    // A card sent again (a bid given back) is a second message of the same card.
    await app.pipeline.resendCard(taskId)
    await until(() => leadCards().length === 2)
    const copy = leadCards().at(-1)?.message_id
    expect(copy).not.toBe(messageId)
    fake.setOrderPage(id, { open: false })
    expect(await app.recheck.tick(first())).toEqual({ checked: 1, closed: 1, doubt: false })
    expect(tg.edited.map((e) => e.message_id).sort()).toEqual([messageId, copy].sort())
    for (const e of tg.edited) {
      expect(e.reply_markup).toEqual({ inline_keyboard: [] })
      expect(e.parse_mode).toBe('HTML')
      // The short closed card: closed, the title, by when, the link; the order text is gone.
      expect(e.text.startsWith(`<b>${TEXTS.closedCard}</b> · ${TITLE} · `)).toBe(true)
      expect(e.text).toContain(`${TEXTS.closedLink}</a>`)
      expect(e.text).not.toContain(BOARD.text)
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

  it('FR-LEAD-5: a closed card is not sent again, and its buttons answer that it is done', async () => {
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
    await app.pipeline.resendCard(taskId)
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

  it('FR-LEAD-5: a task Boris already decided is never read, and its card is left as his close made it', async () => {
    const decided = await shownCard()
    press('skip')
    await until(async () => (await taskOf(decided.id))?.state === 'resolved')
    // His own close edited that card into «📁 Заявка закрыта»; the recheck must not touch it again.
    await until(() => tg.edited.some((e) => e.message_id === decided.messageId))
    tg.edited.length = 0
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

  it('FR-LEAD-5: Boris deciding while the page is being read keeps his decision: the recheck does not touch the card', async () => {
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
    // The only edit is his own close: the short «📁» card, never the site-closed «🔒» one.
    expect(tg.edited.map((e) => e.text.includes('📁 Заявка закрыта'))).toEqual([true])
    expect(await payloads('lead.closed_on_site', id)).toEqual([])
    expect((await leadOf(id))?.status).toBe('skipped')
  }, 60000)
})

describe('a card that waited more than a day (FR-LEAD-10)', () => {
  it('FR-LEAD-10: its message turns into the short stale card, its task ends, and its page is not read', async () => {
    const { id, taskId, messageId } = await shownCard()
    const day = 27 * 3600_000
    await db
      .update(lead)
      .set({ seenAt: new Date(Date.now() - day).toISOString() })
      .where(eq(lead.id, id))
    await db
      .update(task)
      .set({ createdAt: new Date(Date.now() - day).toISOString() })
      .where(eq(task.id, taskId))
    const reads = fake.orderReads.length
    expect(await app.stale.tick()).toEqual({ closed: 1 })
    expect(tg.edited).toHaveLength(1)
    expect(tg.edited[0]).toMatchObject({ message_id: messageId, parse_mode: 'HTML' })
    // No order button is left: only the reasons Boris may press, under Sara's guess (07.11.2026).
    const left = tg.edited[0]?.reply_markup?.inline_keyboard.flat() ?? []
    expect(left.map((b) => b.callback_data.split(':')[2])).toEqual([
      'whyprofile',
      'whybudget',
      'whyclient',
      'whyother',
    ])
    expect(tg.edited[0]?.text).toContain('<i>Похоже, сайт, а не маркетинг</i>')
    expect(tg.edited[0]?.text).toContain(`<b>${TEXTS.staleCard}</b> · ${TITLE} · ждала решения`)
    expect(tg.edited[0]?.text).toContain(`${TEXTS.closedLink}</a>`)
    expect(await taskOf(id)).toMatchObject({ state: 'resolved', resolution: 'skip' })
    expect((await leadOf(id))?.status).toBe('stale')
    expect(await payloads('task.resolved', taskId)).toEqual([{ action: 'skip', reason: 'stale' }])
    // Nothing is read, nothing is said to Boris, and a press on the old message is «Уже сделано».
    expect(await app.recheck.tick(first())).toMatchObject({ checked: 0 })
    expect(fake.orderReads).toHaveLength(reads)
    const answers = tg.answers.length
    tg.pushPress(111, `t:${taskId}:bid`)
    await until(() => tg.answers.length === answers + 1)
    expect(tg.answers.at(-1)?.text).toBe(TEXTS.alreadyDone)
    expect(fake.bids).toHaveLength(0)
    expect(await app.stale.tick()).toEqual({ closed: 0 })
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
    // The next day the same orders are old: old orders closing together are no doubt (27.10.2026), they are closed.
    expect(await app.recheck.tick(plus(at, 25 * 60))).toEqual({
      checked: 3,
      closed: 3,
      doubt: false,
    })
    for (const c of cards) expect((await taskOf(c.id))?.state).toBe('resolved')
    expect(warnings()).toHaveLength(1)
  }, 90000)
})

describe('a bid that ended ORDER_CLOSED (FR-LEAD-5)', () => {
  it('FR-LEAD-5: the card of the order is edited in place, and Boris is told as before', async () => {
    const { id, messageId } = await shownCard()
    fake.refuseNext('ORDER_CLOSED')
    press('bid')
    await until(() => said(TEXTS.bidRefused(TITLE, 'ORDER_CLOSED')))
    const cardEdits = () => tg.edited.filter((e) => e.message_id === messageId)
    // The card folds while the bid goes (#247), then ends as the closed card, still the same message.
    await until(() => (cardEdits().at(-1)?.text ?? '').includes(TEXTS.closedCard))
    expect(cardEdits().at(-1)).toMatchObject({
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    })
    // What Boris pressed stays his decision; the lead is closed all the same.
    expect(await taskOf(id)).toMatchObject({ state: 'resolved', resolution: 'bid' })
    expect((await leadOf(id))?.status).toBe('closed')
    expect(await payloads('lead.closed_on_site', id)).toEqual([{ via: 'press' }])
    await settle()
    expect(leadCards()).toHaveLength(1)
  }, 60000)
})

describe('a fee the first look missed (07.11.2026), and a fee the site changed (10.11.2026)', () => {
  it('FR-LEAD-5: a later look that finds the fee writes it to the lead and draws the waiting card again', async () => {
    const id = orderId()
    const before = leadCards().length
    // The tariff rendered late: the first read of the page has no fee.
    fake.setOrderPage(id, { bid_price_rub: 0 })
    await fake.emitOrder({ order_id: id, ...BOARD, seen_at: plus(first(), -60).toISOString() })
    await until(() => leadCards().length === before + 1)
    await until(async () => (await taskOf(id))?.telegramMessageId != null)
    const messageId = leadCards().at(-1)?.message_id ?? -1
    expect(leadCards().at(-1)?.text).toContain('цена отклика пока неизвестна')
    expect((await leadOf(id))?.bidPriceRub).toBe(0)
    fake.setOrderPage(id, { bid_price_rub: 1250 })
    await app.recheck.tick(first())
    await until(async () => (await leadOf(id))?.bidPriceRub === 1250)
    const edits = () => tg.edited.filter((e) => e.message_id === messageId)
    await until(() => edits().length > 0)
    expect(edits().at(-1)?.text).not.toContain('цена отклика пока неизвестна')
    expect((await taskOf(id))?.state).toBe('open')
    // The site lowers the fee as the order ages (10.11.2026: 110, 55, then 1 ₽ on one order): the card follows it.
    fake.setOrderPage(id, { bid_price_rub: 999 })
    const editsBefore = edits().length
    await app.recheck.tick(plus(first(), 16))
    await until(async () => (await leadOf(id))?.bidPriceRub === 999)
    await until(() => edits().length > editsBefore)
    expect(edits().at(-1)?.text).toContain('999')
    expect(JSON.stringify(edits().at(-1)?.reply_markup)).toContain('Откликнуться за 999')
    // The same fee again draws nothing.
    const editsSame = edits().length
    await app.recheck.tick(plus(first(), 32))
    await settle()
    expect((await leadOf(id))?.bidPriceRub).toBe(999)
    expect(edits()).toHaveLength(editsSame)
  }, 60000)
})
