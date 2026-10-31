import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { queueMessage } from '../../apps/core/src/conversation/outbox'
import { conversation, event, lead, outbox } from '../../apps/core/src/db/schema'
import { isApprovedText, isCallOffer, SLOTS_MARK } from '../../apps/core/src/leads/callSlots'
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
      reconcileDelaysMs: [800, 800],
      quickLookDelaysMs: [250, 250],
      learningTickMs: 3_600_000,
      remindAfterMs: async () => 3_600_000,
      notifyRetry: { maxAttempts: 4, intervalSeconds: 0.5 },
      seriesDelayMs: { first: [400, 500], next: [300, 400], call: [300, 400] },
      // Three times ahead of the moment of sending, whatever the clock of the run says.
      callSlots: {
        slots: async (now) => [3, 5].map((h) => new Date(now.getTime() + h * 3600_000)),
      },
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
  tg.edited.length = 0
  tg.answers.length = 0
  fake.bids.length = 0
  fake.messages.length = 0
  fake.refuseNext('INTERNAL', 0)
  fake.failAcks(0)
  const inChat = new Set<string>()
  // The site puts the bid into the order's chat once, as Profi.ru does; the chat's number is the order's.
  fake.onSubmit(async (i) => {
    if (inChat.has(i.order_id)) return
    inChat.add(i.order_id)
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
  // The call offer has its own test below; the others are about the Analyst's messages.
  await setSetting(db, 'calls.offer', false, 'boris')
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
    expect(await events('bid.series_stopped', id)).toEqual([
      expect.objectContaining({
        n: 0,
        why: 'client_replied',
        detail: expect.objectContaining({ rule: 'client_message' }),
      }),
    ])
    expect(sentTo(id)).toEqual([])
  })

  it('FR-CONV-9: a client who answers after the first message stops the second', async () => {
    const id = await cardFor()
    press()
    await until(() => sentTo(id).length === 1)
    await fake.addChatMessage({ chatId: id, author: 'client', text: 'Да, интересно' })
    await until(async () => (await events('bid.series_stopped', id)).length === 1)
    expect(await events('bid.series_stopped', id)).toEqual([
      expect.objectContaining({ n: 1, why: 'client_replied' }),
    ])
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
    expect(await events('bid.series_stopped', id)).toEqual([
      expect.objectContaining({ n: 0, why: 'not_now' }),
    ])
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

  it('FR-CONV-9: a bid unsure at first and found on its order soon after gets its series all the same', async () => {
    // Every answer of the site is lost: the bid is on the order, the core is unsure and looks for it later.
    fake.failAcks(3)
    const id = await cardFor()
    press()
    await until(async () => (await events('bid.sent', id)).length === 1)
    expect(await events('bid.sent', id)).toEqual([expect.objectContaining({ found_later: true })])
    await until(() => sentTo(id).length === 2)
    expect(sentTo(id).map((m) => m.text)).toEqual([FIRST, SECOND])
    expect(tg.sent.some((m) => m.text.includes('Сообщения вдогонку не отправляла'))).toBe(false)
  })

  it('FR-CONV-9: a bid found on its order long after the press gets its series at once all the same (31.10.2026)', async () => {
    fake.failAcks(3)
    const id = await cardFor()
    press()
    await until(async () =>
      (await db.select().from(outbox).where(eq(outbox.kind, 'bid'))).some(
        (r) => r.state === 'uncertain',
      ),
    )
    // The press was twenty minutes ago by the time the bid shows on its order: no age limit any more.
    await db.execute(
      sql`update core.outbox set created_at = now() - interval '20 minutes' where kind = 'bid'`,
    )
    await until(() => sentTo(id).length === 2)
    expect(sentTo(id).map((m) => m.text)).toEqual([FIRST, SECOND])
    expect(
      tg.sent.concat(tg.edited).some((m) => m.text.includes('Сообщения вдогонку не отправляла')),
    ).toBe(false)
  })

  it('FR-CONV-9: a card of an unknown author, the site itself, does not stop the series (31.10.2026)', async () => {
    const id = await cardFor()
    press()
    await until(() => fake.bids.length === 1)
    await fake.addChatMessage({ chatId: id, author: 'unknown', text: 'Отклик отправлен' })
    await until(() => sentTo(id).length === 2)
    expect(await events('bid.series_stopped', id)).toEqual([])
    expect(sentTo(id)).toHaveLength(2)
  })

  it("FR-CONV-10: the site's tail of the bid (price and contacts, a moment after it) is part of the bid: no stop, the conversation stays Sara's (31.10.2026)", async () => {
    const id = await cardFor()
    press()
    await until(() => fake.bids.length === 1)
    await fake.addChatMessage({
      chatId: id,
      author: 'specialist',
      text: 'Стоимость от 30000 до 45000 руб.\nусл.\nКонтакты:\n+7-900-000-00-00',
    })
    await until(() => sentTo(id).length === 2)
    expect(await events('bid.series_stopped', id)).toEqual([])
    const [conv] = await db.select().from(conversation).where(eq(conversation.orderId, id))
    expect(conv?.owner ?? 'sara').toBe('sara')
  })

  it('FR-UI-1: Boris gets one message for the whole bid: sending, sent, then the line about the series (31.10.2026)', async () => {
    const id = await cardFor()
    press()
    await until(() => tg.sent.some((m) => m.text.startsWith('⏳ Отправляю отклик')))
    await until(() => sentTo(id).length === 2)
    await until(() => tg.edited.some((m) => m.text.includes('Вдогонку ушло 2 сообщения')))
    const [first] = tg.sent.filter((m) => m.text.startsWith('⏳'))
    const edits = tg.edited.filter(
      (m) => m.message_id === (first as { message_id: number }).message_id,
    )
    expect(edits.at(0)?.text).toMatch(/^✅ Отклик отправлен/)
    expect(edits.at(-1)?.text).toMatch(/^✅ Отклик отправлен.*\nВдогонку ушло 2 сообщения/)
    // No pile of notices: nothing else about the bid was sent.
    expect(tg.sent.filter((m) => /Отклик|отклик/.test(m.text) && !m.reply_markup)).toHaveLength(1)
  })

  it('FR-LEAD-4: an unsure bid is looked for within seconds, and «не знаю, ушёл ли» is not said when it shows (31.10.2026)', async () => {
    fake.failAcks(3)
    const id = await cardFor()
    press()
    await until(async () => (await events('bid.sent', id)).length === 1)
    await until(() => sentTo(id).length === 2)
    expect(tg.shown('Не знаю, ушёл ли отклик')).toBe(false)
    expect(tg.edited.some((m) => m.text.startsWith('✅ Отклик отправлен'))).toBe(true)
  })

  it('FR-CONV-9: the series ends with the call offer, its three times put in when it is sent (Boris, 30.10.2026)', async () => {
    await setSetting(db, 'calls.offer', true, 'boris')
    const id = await cardFor()
    const series = (await db.select().from(lead).where(eq(lead.id, id)))[0]?.draftFollowUps ?? []
    expect(series).toHaveLength(3)
    const template = series[2] ?? ''
    expect(isCallOffer(template)).toBe(true)
    // The card shows the offer with its times in words.
    expect(cards().at(-1)?.text).toContain('Созвон')
    press()
    await until(() => sentTo(id).length === 3)
    const [, , call] = sentTo(id).map((m) => m.text)
    expect(call).not.toContain(SLOTS_MARK)
    expect(isApprovedText(template, call ?? '')).toBe(true)
    expect(call).toMatch(/\d{1,2}:\d{2}/)
    expect(sentTo(id)[2]?.idempotency_key).toBe(`msg:series:${id}:2`)
  })

  it('FR-LEAD-6: a link of the list in the stored series is left out at the press, nothing of it is sent (30.10.2026)', async () => {
    const id = await cardFor()
    // A draft made before the site was put on the list still holds its link.
    await db
      .update(lead)
      .set({ draftFollowUps: ['https://nexum.su/ - сайт', FIRST, `${SECOND}\nhttps://nexum.su/`] })
      .where(eq(lead.id, id))
    press()
    await until(() => fake.bids.length === 1)
    const [row] = await db.select().from(outbox).where(eq(outbox.kind, 'bid'))
    // The link-only message goes; a line with the link goes from the message that has words too.
    expect((row?.payload as { followUps?: string[] } | undefined)?.followUps).toEqual([
      FIRST,
      SECOND,
    ])
    await until(() => sentTo(id).length === 2)
    await settle()
    expect(sentTo(id).map((m) => m.text)).toEqual([FIRST, SECOND])
    expect(JSON.stringify(sentTo(id))).not.toContain('nexum')
  })

  it('FR-LEAD-6: a message of Sara’s that holds a link of the list is not queued, Boris’s own words are his', async () => {
    await setSetting(db, 'conv.autopilot', true, 'boris')
    const queued = (author: 'sara' | 'boris', text: string, key: string) =>
      db.transaction((tx) =>
        queueMessage(tx, {
          key,
          accountId: 'hance-marketing',
          chatId: 'chat-links',
          text,
          author,
          expectLast: null,
        }),
      )
    expect(await queued('sara', 'Вот наш сайт https://nexum.su/', 'k1')).toBeNull()
    expect(await queued('sara', 'Вот наш сайт https://zmksk.ru/', 'k2')).not.toBeNull()
    expect(await queued('boris', 'Вот https://nexum.su/ старый сайт', 'k3')).not.toBeNull()
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
