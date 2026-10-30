import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { isTestOrder } from '@sara/shared'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { moscowHour } from '../../apps/core/src/conversation/time'
import { event, lead, task } from '../../apps/core/src/db/schema'
import { cardsToday } from '../../apps/core/src/leads/cardFlow'
import { dayOf } from '../../apps/core/src/leads/money'
import { setSetting } from '../../apps/core/src/settings/store'
import type { TestLeads } from '../../apps/core/src/testLeads/testLeads'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { interlocutorAnswer } from '../../apps/core/test/helpers/conversation'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

// Test orders inside the live Sara (Boris, 30.10.2026; docs/ops/test-leads.md): they come to the live bot marked
// «🧪 Тест», go the whole way against the made-up Profi.ru inside the core, and never reach the node, the money of
// the day or the card cap. The node here is a spy: the fake site, counting every call. Invented texts only.
const ROOT = resolve(import.meta.dirname, '../..')
const BORIS = 111
const FIT = '{"verdict":"fit","reason":"Нужна стратегия","tags":["стратегия"],"confidence":0.9}'
const BODY = 'Прочитал заказ, сети студий важно понять, кто их клиент.\n\nС чего хотите начать?'
const FIRST = 'Из недавнего, похожая задача)'
const SECOND = 'Сделаем быстро и без лишних трат)'
const QUESTION = 'Здравствуйте! А как вы обычно начинаете?'
const REPLY = interlocutorAnswer().text
const NOON = new Date('2026-10-26T09:00:00Z')
const { db, close } = openTestDb()

let tg: FakeTelegram
let node: FakeProfi
let app: RunningApp
let t: TestLeads

async function until(cond: () => boolean | Promise<boolean>, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('condition not met in time')
}
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms))
const lastWith = (start: string) =>
  tg.sent.filter((m) => m.reply_markup && m.text.startsWith(start)).at(-1)
const buttonOf = (start: string, action: string) =>
  lastWith(start)
    ?.reply_markup?.inline_keyboard.flat()
    .find((b) => b.callback_data.endsWith(`:${action}`))?.callback_data ?? ''
const leadCards = () =>
  tg.sent.filter((m) =>
    m.reply_markup?.inline_keyboard.flat().some((b) => b.callback_data.endsWith(':bid')),
  )
const chat = (id: string) =>
  t.stand.fake
    .snapshot()
    .chats.find((c) => c.chatId === id)
    ?.messages.map((m) => `${m.author}: ${m.text}`) ?? []
/** Every order and chat number the spy node was asked about. */
const nodeSaw = () => [
  ...node.orderReads,
  ...node.bids.map((b) => b.order_id),
  ...node.messages.map((m) => m.chat_id),
]

beforeAll(async () => {
  tg = await createFakeTelegram()
  node = await createFakeProfi({
    port: 0,
    coreEventsUrl: 'http://127.0.0.1:1',
    nodeToken: 'node-tok',
    permitSecret: 'permit',
  })
  const dir = await mkdtemp(join(tmpdir(), 'e2e-test-orders-'))
  // The Interlocutor and the Checker answer by the test copy of the roles, as in the conversation e2e.
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
  for (const [name, model] of [
    ['interlocutor', 'sonnet'],
    ['checker', 'haiku'],
  ] as const) {
    await mkdir(join(dir, 'roles', name), { recursive: true })
    await writeFile(
      join(dir, 'roles', name, 'meta.json'),
      JSON.stringify({ name, version: 1, model, priority: 'P0', timeoutMs: 30000 }),
    )
    await writeFile(join(dir, 'roles', name, 'role.md'), 'Роль для теста.')
  }
  app = await startApp(
    {
      ...loadConfig({}),
      databaseUrl: testDatabaseUrl(),
      dataDir: join(dir, 'data'),
      rolesDir: join(dir, 'roles'),
      mindDir: join(dir, 'no-mind'),
      port: 0,
      profiMcpUrl: node.url,
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
          analyst: {
            ...analystAnswer(BODY, 60000),
            follow_ups: [
              { text: FIRST, case_id: null },
              { text: SECOND, case_id: null },
            ],
          },
          interlocutor: interlocutorAnswer(),
        }),
      }),
      retryDelaysMs: [50, 50],
      busyRetry: { delayMs: 50, tries: 2 },
      reconcileDelaysMs: [200, 200],
      learningTickMs: 3_600_000,
      remindAfterMs: async () => 3_600_000,
      notifyRetry: { maxAttempts: 4, intervalSeconds: 0.5 },
      seriesDelayMs: { first: [300, 400], next: [200, 300] },
      now: () => NOON,
      testLeads: {
        timing: {
          readMs: [50, 100],
          firstReplyMs: [1500, 1500],
          replyMs: [800, 800],
          typingMs: 50,
        },
      },
    },
  )
  if (!app.testLeads) throw new Error('test orders did not start')
  t = app.testLeads
  node.setCoreEventsUrl(`${app.url}/internal/profi/events`)
  await app.secrets.set('claude_oauth_token', 'tok')
  await app.secrets.set('telegram_bot_token', tg.token)
  await app.bot.start(tg.token)
}, 60000)

afterAll(async () => {
  await app.close()
  await node.close()
  await tg.close()
  await close()
})

beforeEach(async () => {
  await resetDb(db)
  await t.stand.reset()
  tg.sent.length = 0
  tg.answers.length = 0
  node.orderReads.length = 0
  node.bids.length = 0
  node.messages.length = 0
  tg.pushStart(BORIS)
  await until(() => tg.sent.length === 1)
  tg.sent.length = 0
  // The live Sara as it may well stand: bids and messages to clients paused, the wallet empty, the day's cards spent.
  for (const [key, value] of [
    ['outbound.bids', false],
    ['outbound.messages', false],
    ['pipeline.leads', true],
    ['pipeline.conversations', true],
    ['conv.v1_writes', false],
    ['conv.autopilot', false],
    ['cards.quiet_hours', null],
    ['cards.max_per_day', 1],
    ['money.daily_bids', 1],
    ['conv.quiet_after_message_s', 1],
    ['conv.quiet_after_typing_s', 1],
    ['conv.max_wait_s', 20],
  ] as const)
    await setSetting(db, key, value as never, 'boris')
  node.setHealth({ balance_rub: 0 })
  // Never night here: the night is an hour that starts two hours from now.
  const h = moscowHour(new Date())
  await setSetting(db, 'conv.night', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'boris')
}, 30000)

describe('test orders inside the live Sara', () => {
  it('FR-LEAD-9: order, «Откликнуться», series, the client, the draft, «Отправить»: all marked, none of it at the node, no money', async () => {
    const id = await t.stand.addOrder({
      from: 'sample:90000015',
      behaviour: 'script',
      script: [{ wait_s: 4, text: QUESTION }],
    })
    expect(isTestOrder(id)).toBe(true)
    await until(() => buttonOf('', 'bid') !== '')
    const card = leadCards().at(-1)?.text ?? ''
    expect(card).toContain('🧪 Тест')
    expect(card).not.toContain('profi.ru/backoffice')
    tg.pushPress(BORIS, buttonOf('', 'bid'))
    await until(() => t.stand.fake.bids.length === 1)
    // The bid, its two messages, then the client, who waited until the series was over.
    await until(() => chat(id).length === 4, 40000)
    expect(chat(id).slice(1)).toEqual([
      `specialist: ${FIRST}`,
      `specialist: ${SECOND}`,
      `client: ${QUESTION}`,
    ])
    await until(() => buttonOf('💬', 'send') !== '', 40000)
    expect(lastWith('💬')?.text).toContain('🧪 Тест')
    tg.pushPress(BORIS, buttonOf('💬', 'send'))
    await until(() => chat(id).length === 5, 40000)
    expect(chat(id)[4]).toBe(`specialist: ${REPLY}`)
    await until(() => tg.sent.some((m) => m.text.startsWith('✅') && m.text.includes('🧪 Тест')))
    // Not one call about the test order reached the node.
    expect(nodeSaw().filter((x) => isTestOrder(x))).toEqual([])
    // The day's money and the live wallet never saw it: nothing spent, no bid counted.
    expect(await dayOf(db, new Date())).toMatchObject({ sent: 0, spent: 0, pending: 0 })
    const spends = await db.select().from(event).where(eq(event.type, 'spend.recorded'))
    expect(spends).toEqual([])
  }, 150000)

  it('FR-NOTIF-3: test orders always bring their card and take no place in the day’s cards', async () => {
    const a = await t.stand.addOrder({ from: 'sample', behaviour: 'manual' })
    const b = await t.stand.addOrder({ from: 'sample', behaviour: 'manual' })
    await until(() => leadCards().length === 2)
    expect(await cardsToday(db, new Date())).toBe(0)
    const rows = await db.select({ id: lead.id, status: lead.status }).from(lead)
    expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort())
    expect(rows.every((r) => r.status === 'queued')).toBe(true)
  }, 30000)

  it('FR-LEAD-9: /test in the bot puts a test order in and names the page; «стереть» erases only test orders', async () => {
    tg.pushText(BORIS, '/test выдуманный сам')
    await until(() => tg.sent.some((m) => m.text.includes('Подкинула тестовую заявку')))
    expect(tg.sent.find((m) => m.text.includes('Подкинула'))?.text).toContain('/api/test/')
    await until(() => leadCards().length === 1)
    // A real order meanwhile: the erase leaves it and its journal alone.
    await node.emitOrder({ order_id: '95000123' })
    await until(() => leadCards().length === 2)
    tg.pushText(BORIS, '/test стереть')
    await until(() => tg.sent.some((m) => m.text.includes('Стёрла тестовых заявок: 1')))
    const left = await db.select({ id: lead.id }).from(lead)
    expect(left.map((r) => r.id)).toEqual(['95000123'])
    const testTasks = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(task)
      .where(sql`${task.entityId} ~ '^99[0-9]{9}$'`)
    expect(testTasks[0]?.n).toBe(0)
    // The journal is append-only: its lines about the test order stay, and the counts leave them out.
    expect(await cardsToday(db, new Date())).toBe(1)
    expect(
      await db
        .select()
        .from(event)
        .where(and(eq(event.type, 'lead.found'), eq(event.entityId, '95000123'))),
    ).toHaveLength(1)
    expect(t.stand.fake.snapshot().orders).toEqual([])
    await settle(300)
  }, 40000)

  it('FR-LEAD-9: the page of test orders asks for the pult password, then serves the page and its calls', async () => {
    const page = await fetch(`${app.url}/api/test/`)
    expect(page.status).toBe(401)
    expect(await page.text()).toContain('Пароль тот же, что у пульта')
    expect((await fetch(`${app.url}/api/test/state`)).status).toBe(401)
    const r0 = await fetch(`${app.url}/api/setup/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'длинныйпароль1' }),
    })
    const cookie = (r0.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const ok = await fetch(`${app.url}/api/test/`, { headers: { cookie } })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('Тестовые заявки')
    const added = await fetch(`${app.url}/api/test/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ from: 'sample', behaviour: 'manual' }),
    })
    const { orderId } = (await added.json()) as { orderId: string }
    expect(isTestOrder(orderId)).toBe(true)
    const wiped = await fetch(`${app.url}/api/test/wipe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    })
    expect(await wiped.json()).toMatchObject({ erased: expect.any(Number) })
  }, 30000)
})
