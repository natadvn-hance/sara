import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { isTestOrder } from '@sara/shared'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { event, lead, modelCall, outbox, question, task } from '../../apps/core/src/db/schema'
import { seedDirection } from '../../apps/core/src/direction/store'
import { askWhy } from '../../apps/core/src/learning/questions'
import { PULT_TEXTS } from '../../apps/core/src/pult/routes'
import { SECRETARY_MCP_PATH } from '../../apps/core/src/secretary/mcp'
import { SECRETARY_TEXTS } from '../../apps/core/src/secretary/secretary'
import { getSetting, setSetting } from '../../apps/core/src/settings/store'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { scorerAnswer } from '../../apps/core/test/helpers/scorer'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

const ROOT = resolve(import.meta.dirname, '../..')
const FIT = { verdict: 'fit', reason: 'Нужен сайт', tags: ['сайт'], confidence: 0.9 }
const ANALYST = analystAnswer(
  'Понимаю, клинике важно быстро начать запись.\n\nКогда хотите открыть запись онлайн?',
)
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let n = 0
const claudeLog = join(tmpdir(), `e2e-secretary-claude-${process.pid}.log`)
const orderId = () => `${Date.now()}${n++}`
/** What each role answers; the Secretary's answer is a script of tool calls and words (tests/fakes/fake-claude.mjs). */
let byRole: Record<string, unknown> = {}
/** More fake CLI settings for the next runs (a slow answer, say). */
let moreEnv: Record<string, string> = {}

async function until(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}
const cards = () => tg.sent.filter((m) => m.reply_markup)
const lastText = () => tg.sent.at(-1)?.text ?? ''
type Logged = {
  args?: string[]
  stdin?: string
  tools?: { name: string; text: string; isError: boolean }[]
}
const logged = async (): Promise<Logged[]> =>
  (await readFile(claudeLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Logged)
const isSecretary = (c: Logged) => c.args?.some((a) => a.endsWith('secretary/role.md')) ?? false
/** The Secretary's runs: what it read, and what its tools answered it (as the model saw them). */
const turns = async () => {
  const all = await logged()
  return all.flatMap((c, i) =>
    isSecretary(c)
      ? [{ stdin: c.stdin ?? '', tools: all.slice(i + 1).find((x) => x.tools)?.tools ?? [] }]
      : [],
  )
}
const turnCount = async () => (await turns()).length
/** A card of an order seen now, and its decision task. */
async function leadCard(): Promise<{ id: string; taskId: string }> {
  const id = orderId()
  const before = cards().length
  await fake.emitOrder({ order_id: id })
  await until(() => cards().length === before + 1)
  const [t] = await db
    .select()
    .from(task)
    .where(and(eq(task.entityId, id), eq(task.kind, 'lead_decision')))
  return { id, taskId: t?.id ?? '' }
}
const answered = async () =>
  (await db.select().from(event).where(eq(event.type, 'secretary.answered'))).length
/** Boris writes and the Secretary's turn ends; the words the bot sent meanwhile. */
async function boris(text: string): Promise<string> {
  const sent = tg.sent.length
  const before = await answered()
  tg.pushText(111, text)
  await until(async () => (await answered()) > before)
  return tg.sent
    .slice(sent)
    .map((m) => m.text)
    .join('\n')
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
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-secretary-')),
      port: 0,
      profiMcpUrl: fake.url,
      nodeToken: 'node-tok',
      permitSecret: 'permit',
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      telegramApiRoot: tg.apiRoot,
      publicUrl: 'https://sara.test',
    },
    {
      claudeEnv: () => ({
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify(byRole),
        FAKE_CLAUDE_ARGS_LOG: claudeLog,
        FAKE_CLAUDE_COUNTER_FILE: `${claudeLog}.count`,
        ...moreEnv,
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
  await rm(claudeLog, { force: true })
  await rm(`${claudeLog}.count`, { force: true })
  moreEnv = {}
  byRole = { sorter: FIT, scorer: scorerAnswer(70), analyst: ANALYST }
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  tg.sent.length = 0
  tg.answers.length = 0
  tg.actions.length = 0
  fake.bids.length = 0
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'pipeline.leads', true, 'boris')
  await setSetting(db, 'outbound.bids', true, 'boris')
})

describe('the Secretary in the bot', () => {
  it('FR-NOTIF-4: «что в очереди» Sara answers from the core with the order link; the model sees the client hidden', async () => {
    const { id } = await leadCard()
    byRole.secretary = {
      calls: [{ name: 'leads' }, { name: 'lead', arguments: { orderId: id } }],
      answer: 'В очереди одна заявка: {{0}}\n\nПодробно: {{1}}',
    }
    const words = await boris('Что в очереди?')
    const [turn] = await turns()
    expect(turn?.stdin).toContain('## Новое сообщение Бориса\nЧто в очереди?')
    // The tools answered the model with tags, never the order's link or the client's name (ADR-016)...
    expect(turn?.tools.map((t) => t.isError)).toEqual([false, false])
    expect(turn?.tools[0]?.text).toContain('"url":"[ссылка')
    expect(turn?.tools[1]?.text).toContain('"clientName":"[имя')
    expect(turn?.tools.map((t) => t.text).join('')).not.toContain('profi.ru')
    expect(turn?.tools[1]?.text).not.toContain('Ирина')
    // ...and Boris gets them back in Sara's words.
    expect(words).toContain(`https://profi.ru/backoffice/n.php?o=${id}`)
    expect(words).toContain('"clientName":"Ирина"')
    expect(tg.actions).toContain('typing')
  })

  it('FR-NOTIF-4: Sara remembers the conversation: the next turn reads the last exchange', async () => {
    byRole.secretary = { $sequence: [{ answer: 'На балансе 5000 ₽.' }, { answer: 'Помню.' }] }
    expect(await boris('скок на балансе')).toBe('На балансе 5000 ₽.')
    await boris('а вчера сколько было?')
    const [, second] = await turns()
    expect(second?.stdin).toMatch(
      /## Наш разговор\n\[Борис, [^\]]+\] скок на балансе\n\[Сара, [^\]]+\] На балансе 5000 ₽\./,
    )
    expect(second?.stdin).toContain('## Новое сообщение Бориса\nа вчера сколько было?')
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(modelCall)
    expect(rows[0]?.n).toBe(2)
  })

  it('FR-NOTIF-4: words written while Sara answers wait and go together in the next turn, after her answer', async () => {
    byRole.secretary = { $sequence: [{ answer: 'Смотрю очередь.' }, { answer: 'Поняла оба.' }] }
    moreEnv = { FAKE_CLAUDE_DELAY_MS: '1500' }
    const before = await answered()
    tg.pushText(111, 'что в очереди')
    // «печатает…» goes when the turn starts; the fake CLI answers 1.5 s later.
    await until(() => tg.actions.length > 0)
    tg.pushText(111, 'и ещё')
    tg.pushText(111, 'про кофейни тоже')
    await until(async () => (await answered()) === before + 2)
    const [, second] = await turns()
    expect(second?.stdin).toMatch(
      /\[Борис, [^\]]+\] что в очереди\n\[Сара, [^\]]+\] Смотрю очередь\./,
    )
    expect(second?.stdin).toMatch(
      /## Новое сообщение Бориса\n\[\d\d:\d\d\] и ещё\n\[\d\d:\d\d\] про кофейни тоже$/,
    )
    expect(await turnCount()).toBe(2)
  })

  it('FR-NOTIF-4: «откликнись на N» brings the bid button and spends nothing; only the press bids', async () => {
    const { id, taskId } = await leadCard()
    byRole.secretary = {
      calls: [{ name: 'offer_bid', arguments: { taskId } }],
      answer: 'Прислала кнопку.',
    }
    await boris(`откликнись на ${id}`)
    const offer = tg.sent.find(
      (m) =>
        m.reply_markup?.inline_keyboard.flat().some((b) => b.callback_data === `t:${taskId}:bid`) &&
        m.text.startsWith('Откликнуться на'),
    )
    expect(offer?.text).toContain(`n.php?o=${id}`)
    expect(fake.bids).toHaveLength(0)
    expect(await db.select().from(outbox)).toHaveLength(0)
    expect((await turns())[0]?.tools[0]?.text).toContain('Деньги уйдут только по его нажатию')
    tg.pushPress(111, `t:${taskId}:bid`)
    await until(() => fake.bids.length === 1)
  })

  it('FR-LEAD-9: «подкинь тестовую заявку» starts test orders through the bot’s own function, «сотри тестовые» erases only them', async () => {
    const live = orderId()
    await fake.emitOrder({ order_id: live })
    await until(async () => (await db.select().from(lead)).length === 1)
    byRole.secretary = {
      calls: [
        { name: 'start_test_leads', arguments: { scenario: 'price', count: 2, invented: true } },
      ],
      answer: 'Подкинула две тестовые заявки.',
    }
    await boris('подкинь две тестовые заявки, клиент просит цену')
    const ids = async () => (await db.select({ id: lead.id }).from(lead)).map((r) => r.id)
    await until(async () => (await ids()).filter(isTestOrder).length === 2, 20000)
    const started = (await turns())[0]?.tools[0]
    expect(started?.isError).toBe(false)
    expect(started?.text.match(/Подкинула тестовую заявку/g)).toHaveLength(2)
    expect(started?.text).toContain('клиент: просит цену')
    expect(started?.text).toContain('выдуманная')
    byRole.secretary = {
      calls: [{ name: 'clear_test_leads' }],
      answer: 'Стёрла тестовые.',
    }
    await boris('сотри тестовые')
    const cleared = (await turns())[1]?.tools[0]
    expect(cleared?.text).toContain('Стёрла тестовых заявок: 2')
    expect(await ids()).toEqual([live])
    // None of it reached the node or the money: nothing was bid and nothing sent to a client.
    expect(fake.bids).toHaveLength(0)
    expect(await db.select().from(outbox)).toHaveLength(0)
  }, 60000)

  it('FR-LEAD-9: the tools refuse a scenario that does not exist and more than five orders', async () => {
    byRole.secretary = {
      calls: [
        { name: 'start_test_leads', arguments: { scenario: 'мошенник' } },
        { name: 'start_test_leads', arguments: { count: 6 } },
      ],
      answer: 'Не вышло.',
    }
    await boris('подкинь тестовые')
    const [a, b] = (await turns())[0]?.tools ?? []
    expect([a?.isError, b?.isError]).toEqual([true, true])
    expect((await db.select().from(lead)).filter((r) => isTestOrder(r.id))).toEqual([])
  })

  it('FR-NOTIF-4: «поставь на паузу» stops the bids at once; turning them on again is refused', async () => {
    byRole.secretary = {
      calls: [
        { name: 'set_setting', arguments: { key: 'outbound.bids', value: false } },
        { name: 'set_setting', arguments: { key: 'outbound.bids', value: true } },
        { name: 'set_setting', arguments: { key: 'pipeline.leads', value: false } },
      ],
      answer: 'Поставила на паузу.',
    }
    await boris('поставь на паузу')
    expect(await getSetting(db, 'outbound.bids')).toBe(false)
    expect(await getSetting(db, 'pipeline.leads')).toBe(true)
    const [, on, locked] = (await turns())[0]?.tools ?? []
    expect(on?.text).toContain(PULT_TEXTS.locked)
    expect(locked?.text).toContain(PULT_TEXTS.locked)
  })

  it("FR-NOTIF-4: after a «почему?» a request goes to the Secretary with the question, and its answer takes Boris's exact words", async () => {
    const { id } = await leadCard()
    await askWhy(
      { db, notifier: app.bot.notifier },
      { kind: 'why_skip', entityId: id, title: 'Сайт для клиники' },
      new Date(),
    )
    const [q] = await db.select().from(question)
    byRole.secretary = {
      calls: [{ name: 'answer_question', arguments: { questionId: q?.id } }],
      answer: 'Записала причину.',
    }
    await boris('почему? клиенту нужен только лендинг')
    expect((await turns())[0]?.stdin).toContain(
      `## Открытый вопрос\n- questionId ${q?.id}: почему он пропустил заявку («`,
    )
    const [answered] = await db
      .select()
      .from(question)
      .where(eq(question.id, q?.id ?? ''))
    expect(answered?.answer).toBe('почему? клиенту нужен только лендинг')
    expect((await turns())[0]?.tools[0]?.text).toContain('Записала по «')
  })

  it('FR-LEAD-7: a plain reason after a «почему?» is noted at once, as before, without the Secretary', async () => {
    const { id } = await leadCard()
    await askWhy(
      { db, notifier: app.bot.notifier },
      { kind: 'why_skip', entityId: id, title: 'Сайт для клиники' },
      new Date(),
    )
    tg.pushText(111, 'бюджет копейки')
    await until(
      () => lastText().startsWith('Записала по «') && lastText().endsWith('«бюджет копейки»'),
    )
    expect(await turnCount()).toBe(0)
  })

  it('FR-NOTIF-1: the bot talks only to Boris: a stranger reaches no model, and the tools open only for a running turn', async () => {
    tg.pushText(999, 'что в очереди')
    await until(
      async () =>
        (await db.select().from(event).where(eq(event.type, 'security.foreign_chat'))).length > 0,
    )
    expect(await turnCount()).toBe(0)
    for (const auth of [undefined, `Bearer ${'0'.repeat(64)}`]) {
      const res = await fetch(`${app.url}${SECRETARY_MCP_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(auth && { authorization: auth }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(res.status).toBe(404)
    }
  })

  it("FR-NOTIF-4: past the day's turns Sara says so and runs nothing more", async () => {
    await setSetting(db, 'secretary.turns_per_day', 1, 'boris')
    byRole.secretary = { answer: 'Привет.' }
    expect(await boris('привет')).toBe('Привет.')
    expect(await boris('а ещё?')).toBe(SECRETARY_TEXTS.cap(1))
    expect(await turnCount()).toBe(1)
    const ends = await db
      .select({ reason: event.reason })
      .from(event)
      .where(eq(event.type, 'secretary.answered'))
    expect(ends.map((e) => e.reason)).toEqual([null, 'cap'])
  })
})
