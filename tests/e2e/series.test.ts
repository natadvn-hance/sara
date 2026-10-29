import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { queueMessage } from '../../apps/core/src/conversation/outbox'
import { event, lead, outbox } from '../../apps/core/src/db/schema'
import { setSetting } from '../../apps/core/src/settings/store'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

// The series after a bid (Boris, 29.10.2026): one press on «Откликнуться» sends the bid and, a minute or two later,
// the one or two short messages the Analyst wrote with it, until the client answers. Invented orders and texts only.
const ROOT = resolve(import.meta.dirname, '../..')
const FIT = '{"verdict":"fit","reason":"Нужен сайт","tags":["сайт"],"confidence":0.9}'
const BODY = 'Прочитал описание, клинике важно быстро начать запись.\n\nКогда хотите начать?'
const FIRST = 'Из недавнего, похожая задача)'
const SECOND = 'Сделаем быстро, качественно и без лишних трат)'
const NOON = new Date('2026-10-26T09:00:00Z')
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let n = 0
let series: { text: string; case_id: string | null }[] = [
  { text: FIRST, case_id: null },
  { text: SECOND, case_id: null },
]
/** The client writes as soon as the bid is in the chat. */
let clientFirst = false
const orderId = () => `${Date.now()}${n++}`

async function until(cond: () => boolean | Promise<boolean>, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}
const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms))
const cards = () => tg.sent.filter((m) => m.reply_markup)
const button = (action: string, m = cards().at(-1)) =>
  m?.reply_markup?.inline_keyboard.flat().find((b) => b.callback_data.endsWith(`:${action}`))
const press = (action = 'bid') => tg.pushPress(111, button(action)?.callback_data ?? '')
const events = async (type: string, id: string) =>
  (
    await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, type), eq(event.entityId, id)))
  ).map((e) => e.payload)
const sentTo = (id: string) => fake.messages.filter((m) => m.chat_id === id)

async function cardFor(id = orderId()) {
  const before = cards().length
  await fake.emitOrder({ order_id: id })
  await until(() => cards().length === before + 1)
  return id
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
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-series-')),
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
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
          analyst: { ...analystAnswer(BODY, 30000), follow_ups: series },
        }),
      }),
      retryDelaysMs: [50, 50],
      busyRetry: { delayMs: 50, tries: 2 },
      reconcileDelaysMs: [200, 200],
      learningTickMs: 3_600_000,
      remindAfterMs: async () => 3_600_000,
      notifyRetry: { maxAttempts: 4, intervalSeconds: 0.5 },
      seriesDelayMs: { first: [400, 500], next: [300, 400] },
      now: () => NOON,
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
  series = [
    { text: FIRST, case_id: null },
    { text: SECOND, case_id: null },
  ]
  clientFirst = false
  await resetDb(db)
  tg.sent.length = 0
  tg.answers.length = 0
  fake.bids.length = 0
  fake.messages.length = 0
  fake.refuseNext('INTERNAL', 0)
  // The site puts the bid into the order's chat, as Profi.ru does; the chat's number is the order's.
  fake.onSubmit(async (i) => {
    await fake.addChatMessage({
      chatId: i.order_id,
      orderId: i.order_id,
      author: 'specialist',
      text: i.text,
    })
    if (clientFirst)
      await fake.addChatMessage({ chatId: i.order_id, author: 'client', text: 'Здравствуйте!' })
  })
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'outbound.bids', true, 'boris')
  await setSetting(db, 'pipeline.leads', true, 'boris')
  await setSetting(db, 'cards.quiet_hours', null, 'boris')
  // Drafts mode as it is live (27.10.2026): Sara writes to clients only with Boris's press.
  await setSetting(db, 'outbound.messages', true, 'boris')
  await setSetting(db, 'conv.v1_writes', false, 'boris')
  await setSetting(db, 'conv.autopilot', false, 'boris')
})

describe('the series after a bid (Boris, 29.10.2026)', () => {
  it('FR-CONV-9: one press sends the bid and then its two messages into the order chat, each once, in drafts mode', async () => {
    const id = await cardFor()
    expect((await db.select().from(lead).where(eq(lead.id, id)))[0]?.draftFollowUps).toEqual([
      FIRST,
      SECOND,
    ])
    // The journal counts the series and the case it shows, never its text (ADR-016).
    expect((await events('lead.drafted', id))[0]).toMatchObject({
      follow_ups: 2,
      follow_up_cases: [],
      follow_ups_dropped: [],
    })
    press()
    await until(() => sentTo(id).length === 2)
    expect(fake.bids).toHaveLength(1)
    expect(sentTo(id).map((m) => m.text)).toEqual([FIRST, SECOND])
    expect(sentTo(id).map((m) => m.idempotency_key)).toEqual([
      `msg:series:${id}:0`,
      `msg:series:${id}:1`,
    ])
    await until(async () => (await events('bid.series_sent', id)).length === 2)
    expect(await events('bid.series_sent', id)).toEqual([{ n: 0 }, { n: 1 }])
    // Never a second time: the process is one per order.
    await settle()
    expect(sentTo(id)).toHaveLength(2)
    expect(await events('bid.series_stopped', id)).toEqual([])
  })

  it('FR-CONV-9: a client who answered before the series stops it, nothing is sent', async () => {
    clientFirst = true
    const id = await cardFor()
    press()
    await until(async () => (await events('bid.series_stopped', id)).length === 1)
    expect(await events('bid.series_stopped', id)).toEqual([{ n: 0, why: 'client_replied' }])
    expect(sentTo(id)).toEqual([])
  })

  it('FR-CONV-9: a client who answers after the first message stops the second', async () => {
    const id = await cardFor()
    press()
    await until(() => sentTo(id).length === 1)
    await fake.addChatMessage({ chatId: id, author: 'client', text: 'Да, интересно' })
    await until(async () => (await events('bid.series_stopped', id)).length === 1)
    expect(await events('bid.series_stopped', id)).toEqual([{ n: 1, why: 'client_replied' }])
    expect(sentTo(id).map((m) => m.text)).toEqual([FIRST])
  })

  it('FR-CONV-9: Boris writing in the chat himself stops the series', async () => {
    const id = await cardFor()
    press()
    await until(() => fake.bids.length === 1)
    await fake.addChatMessage({ chatId: id, author: 'specialist', text: 'Пишу сам' })
    await until(async () => (await events('bid.series_stopped', id)).length === 1)
    // Seen in the chat, or the conversation already became his by the owner rule (FR-CONV-10): either way it stops.
    const [stopped] = (await events('bid.series_stopped', id)) as { n: number; why: string }[]
    expect(stopped?.n).toBe(0)
    expect(['boris_wrote', 'boris_leads']).toContain(stopped?.why)
    expect(sentTo(id)).toEqual([])
  })

  it('FR-CONV-9: the pause of messages to clients holds for the series', async () => {
    await setSetting(db, 'outbound.messages', false, 'boris')
    const id = await cardFor()
    press()
    await until(async () => (await events('bid.series_stopped', id)).length === 1)
    expect(await events('bid.series_stopped', id)).toEqual([{ n: 0, why: 'not_now' }])
    expect(sentTo(id)).toEqual([])
  })

  it('FR-CONV-9: a bid that did not go has no series', async () => {
    fake.refuseNext('LAYOUT_CHANGED', 1)
    const id = await cardFor()
    press()
    await until(async () => (await events('bid.failed', id)).length === 1)
    await settle()
    expect(fake.bids).toEqual([])
    expect(sentTo(id)).toEqual([])
    expect(await events('bid.series_stopped', id)).toEqual([])
  })

  it('FR-LEAD-7: Boris edits the series on the pult, and his version is what follows the bid', async () => {
    const r0 = await fetch(`${app.url}/api/setup/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'длинныйпароль1' }),
    })
    const cookie = (r0.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const id = await cardFor()
    const r = await fetch(`${app.url}/api/leads/${id}/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ followUps: ['Свой вариант)', '  '] }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { message: string }).message).toContain(
      'Записала сообщения вдогонку',
    )
    expect((await db.select().from(lead).where(eq(lead.id, id)))[0]?.draftFollowUps).toEqual([
      'Свой вариант)',
    ])
    expect(await events('draft.edited', id)).toEqual([
      { before: `${FIRST}\n\n${SECOND}`, after: 'Свой вариант)', voice: false, part: 'follow_ups' },
    ])
    press()
    await until(() => sentTo(id).length === 1)
    await settle()
    expect(sentTo(id).map((m) => m.text)).toEqual(['Свой вариант)'])
  })

  it('FR-CONV-5: in drafts mode only the series Boris pressed passes: another text under its key is refused', async () => {
    const id = await cardFor()
    press()
    await until(() => sentTo(id).length === 2)
    const queued = (text: string, key: string, chatId = id) =>
      db.transaction((tx) =>
        queueMessage(tx, {
          key,
          accountId: 'hance-marketing',
          chatId,
          text,
          author: 'sara',
          expectLast: null,
        }),
      )
    expect(await queued('Другой текст', `series:${id}:1:2`)).toBeNull()
    expect(await queued(SECOND, `series:${id}:1:2`, 'another-chat')).toBeNull()
    expect(await queued(SECOND, `series:${orderId()}:1`)).toBeNull()
    // The approved text, its key, the order's chat: it would pass.
    expect(await queued(SECOND, `series:${id}:1:2`)).not.toBeNull()
    expect((await db.select().from(outbox).where(eq(outbox.kind, 'message'))).length).toBe(3)
  })
})
