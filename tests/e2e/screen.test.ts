import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { LeadScreen } from '@sara/shared'
import { and, asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { event, lead, leadScore } from '../../apps/core/src/db/schema'
import { seedDirection } from '../../apps/core/src/direction/store'
import { dailySummary } from '../../apps/core/src/learning/summary'
import { readFeed } from '../../apps/core/src/pult/feed'
import { leadView } from '../../apps/core/src/pult/leads'
import { setSetting } from '../../apps/core/src/settings/store'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { summaryTime } from '../../apps/core/test/helpers/learning'
import { scorerAnswer } from '../../apps/core/test/helpers/scorer'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

/** Stage 1 «Отсев» (Boris, 30.10.2026, docs/product/lead-analysis.md) through the whole pipeline. */

const ROOT = resolve(import.meta.dirname, '../..')
const FIT = { verdict: 'fit', reason: 'Нужен сайт', tags: ['сайт'], confidence: 0.9 }
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let log: string
let n = 0
const orderId = () => `${Date.now()}${n++}`
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
const leadCards = () =>
  tg.sent.filter((m) =>
    m.reply_markup?.inline_keyboard.flat().some((b) => b.callback_data.endsWith(':bid')),
  )
const leadOf = async (id: string) => (await db.select().from(lead).where(eq(lead.id, id)))[0]
const screenOf = async (id: string) => LeadScreen.parse((await leadOf(id))?.screen)
const journal = async (id: string) =>
  db
    .select({ type: event.type, payload: event.payload })
    .from(event)
    .where(and(eq(event.entityId, id), eq(event.entityKind, 'lead')))
    .orderBy(asc(event.id))
const inputsOf = (role: string): string[] =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args: string[]; stdin: string })
    .filter((c) => c.args.some((a) => a.endsWith(`roles/${role}/role.md`)))
    .map((c) => c.stdin)

/** 19 own words: never short. */
const LONG =
  'Нужен сайт для клиники с онлайн записью, страницами врачей и услуг, чтобы получать больше заявок из поиска и рекламы'
const DIRECT =
  'Нужно настроить рекламу в Директе для салона красоты, сейчас заявок мало, хотим понять, сколько можно получать в месяц'
const CLIENT = {
  name: 'Ирина',
  on_profi_since: 'На Профи.ру с 7 сентября 2020',
  phone_verified: true,
  reviews: { positive: 3, negative: 1 },
  review_tags: [],
}
/** «На Профи.ру с 30 октября 2026» for today in Moscow. */
const today = () =>
  `На Профи.ру с ${new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
    .format(new Date())
    .replace(/\s*г\.?$/, '')}`

beforeAll(async () => {
  tg = await createFakeTelegram()
  log = join(await mkdtemp(join(tmpdir(), 'e2e-screen-log-')), 'claude.log')
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
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-screen-')),
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

describe('the screen on: a criterion that fired stops the order', () => {
  beforeEach(async () => {
    await setSetting(db, 'screen.stops', true, 'boris')
  })

  it('criterion 3: fewer than 15 own words stop the order before any model call or page visit', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id, title: 'Сайт', text: '50 000' })
    await until(async () => (await leadOf(id))?.status === 'screened_out')
    await settle()
    expect(inputsOf('sorter')).toEqual([])
    expect(fake.orderReads).toEqual([])
    expect(leadCards()).toHaveLength(0)
    const s = await screenOf(id)
    expect(s.hits).toEqual([
      { criterion: 'short_text', basis: 'пустой заказ: нет ни своих слов, ни ответов формы' },
    ])
    expect(s.no_data).toEqual(['new_account', 'negative_reviews'])
    const e = (await journal(id)).find((x) => x.type === 'lead.screened')
    expect(e?.payload).toMatchObject({ stops: true, out: true, criteria: ['short_text'] })
    // The basis is on the lead, never in the journal.
    expect(JSON.stringify(e?.payload)).not.toContain('пустой')
  })

  it('the threshold of own words is a setting', async () => {
    await setSetting(db, 'screen.min_own_words', 3, 'boris')
    const id = orderId()
    await fake.emitOrder({ order_id: id, title: 'Сайт', text: 'Нужен сайт для клиники' })
    await until(() => leadCards().length === 1)
    expect((await screenOf(id)).hits).toEqual([])
  })

  it('criterion 3 is soft when the client wrote a little: the order goes on and loses 5 points', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id, title: 'Сайт', text: 'Нужен сайт для клиники' })
    await until(() => leadCards().length === 1)
    const s = await screenOf(id)
    expect(s.hits).toEqual([])
    expect(s).toMatchObject({ soft: [{ criterion: 'short_text' }], penalty: 5 })
    expect((await leadOf(id))?.status).not.toBe('screened_out')
  })

  it('criterion 4: the Sorter names the core with a quote of the order: stopped, no Scorer call', async () => {
    byRole = {
      ...byRole,
      sorter: {
        ...FIT,
        screen: [{ criterion: 'direct', verdict: 'core', quote: 'настроить рекламу в Директе' }],
      },
    }
    const id = orderId()
    await fake.emitOrder({ order_id: id, title: 'Реклама', text: DIRECT })
    await until(async () => (await leadOf(id))?.status === 'screened_out')
    await settle()
    expect(inputsOf('scorer')).toEqual([])
    expect(fake.orderReads).toEqual([])
    expect((await screenOf(id)).hits).toEqual([
      { criterion: 'direct', basis: '«настроить рекламу в Директе»' },
    ])
    const types = (await journal(id)).map((x) => x.type)
    expect(types).toContain('lead.sorted')
    expect(types).toContain('lead.screened')
    // The Sorter's verdict goes into the journal without the screen's quotes.
    const sorted = (await journal(id)).find((x) => x.type === 'lead.sorted')
    expect(sorted?.payload).toEqual({ verdict: 'fit', reason: 'Нужен сайт' })
  })

  it('a core whose quote is not in the order has no basis: the order goes on, the card asks to clarify', async () => {
    byRole = {
      ...byRole,
      sorter: {
        ...FIT,
        screen: [{ criterion: 'direct', verdict: 'core', quote: 'вести Директ каждый день' }],
      },
    }
    const id = orderId()
    await fake.emitOrder({ order_id: id, title: 'Реклама', text: DIRECT })
    await until(() => leadCards().length === 1)
    expect((await leadOf(id))?.status).toBe('queued')
    expect(leadCards()[0]?.text).toContain('Уточнить в отклике: Яндекс Директ')
  })

  it('a background mention or a doubt never stops the order', async () => {
    byRole = {
      ...byRole,
      sorter: {
        ...FIT,
        screen: [{ criterion: 'small_fix', verdict: 'unclear', quote: 'Нужен сайт для клиники' }],
      },
    }
    const id = orderId()
    await fake.emitOrder({ order_id: id, title: 'Сайт', text: LONG })
    await until(() => leadCards().length === 1)
    expect((await screenOf(id)).clarify.map((c) => c.criterion)).toEqual(['small_fix'])
  })

  it('criterion 1: an account made today, seen on the order page, stops the order before the Analyst', async () => {
    const id = orderId()
    fake.setOrderPage(id, {
      bid_price_rub: 145,
      client_info: { ...CLIENT, on_profi_since: today() },
    })
    await fake.emitOrder({ order_id: id, title: 'Сайт', text: LONG })
    await until(async () => (await leadOf(id))?.status === 'screened_out')
    await settle()
    expect(fake.orderReads).toEqual([id])
    expect(inputsOf('analyst')).toEqual([])
    expect(leadCards()).toHaveLength(0)
    const s = await screenOf(id)
    expect(s.hits.map((h) => h.criterion)).toEqual(['new_account'])
    expect(s.hits[0]?.basis).toContain(today())
    expect(s.no_data).toEqual([])
    const types = (await journal(id)).map((x) => x.type)
    expect(types.indexOf('lead.screened')).toBeGreaterThan(types.indexOf('lead.page_read'))
  })

  it('criterion 2: three negative reviews on the page stop the order', async () => {
    const id = orderId()
    fake.setOrderPage(id, { client_info: { ...CLIENT, reviews: { positive: 4, negative: 3 } } })
    await fake.emitOrder({ order_id: id, title: 'Сайт', text: LONG })
    await until(async () => (await leadOf(id))?.status === 'screened_out')
    expect((await screenOf(id)).hits).toEqual([
      { criterion: 'negative_reviews', basis: 'негативных отзывов 3, положительных 4' },
    ])
  })

  it('no data, no stop: a page without the client leaves criteria 1-2 unfired and the card comes', async () => {
    const id = orderId()
    fake.setOrderPage(id, { bid_price_rub: 145 })
    await fake.emitOrder({ order_id: id, title: 'Сайт', text: LONG })
    await until(() => leadCards().length === 1)
    const s = await screenOf(id)
    expect(s.hits).toEqual([])
    expect(s.no_data).toEqual(['new_account', 'negative_reviews'])
    expect(s.own_words).toBe(19)
  })

  it('the pult shows the stopped order with its basis, and the summary counts it by criterion', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id, title: 'Сайт', text: '50 000' })
    await until(async () => (await leadOf(id))?.status === 'screened_out')
    const v = await leadView(db, id)
    expect(v?.screen?.hits[0]?.criterion).toBe('short_text')
    expect((await readFeed(db)).map((f) => f.text)).toContain('Отсеяла «Сайт»: Короткий текст')
    tg.sent.length = 0
    expect(await dailySummary({ db: app.db, notifier: app.bot.notifier }, summaryTime())).toBe(
      'sent',
    )
    expect(tg.sent.map((m) => m.text).join('\n')).toContain('Отсеяно 1: Короткий текст 1')
  })
})

describe('the shadow (the default): the screen only marks', () => {
  it('a criterion that fired is stored, the order goes on and the card comes', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id, title: 'Сайт', text: '50 000' })
    await until(() => leadCards().length === 1)
    expect((await leadOf(id))?.status).toBe('queued')
    const s = await screenOf(id)
    expect(s).toMatchObject({ stops: false, hits: [{ criterion: 'short_text' }] })
    expect((await readFeed(db)).map((f) => f.text)).toContain('Отсеяла бы «Сайт»: Короткий текст')
    tg.sent.length = 0
    await dailySummary({ db: app.db, notifier: app.bot.notifier }, summaryTime())
    expect(tg.sent.map((m) => m.text).join('\n')).toContain(
      'Отсеяла бы 1 (отсев пока только отмечает): Короткий текст 1',
    )
  })
})

describe('criterion 7: vacancy', () => {
  const JOB = {
    title: 'Маркетолог',
    text: 'Ищем маркетолога в команду для развития нашего салона. Обязанности: ведение соцсетей, реклама, отчёты по заявкам. Требования: опыт от 2 лет. Оклад от 80 тыс. в месяц, график 5/2.',
  }
  const LIKE = {
    title: 'Маркетолог',
    text: 'Нужен маркетолог в команду для развития нашего салона красоты, ищем сотрудника, который сможет вести рекламу, соцсети и считать заявки каждый месяц.',
  }

  it('a clear vacancy stops with the screen on, before the Sorter, quotes as the basis', async () => {
    await setSetting(db, 'screen.stops', true, 'boris')
    const id = orderId()
    await fake.emitOrder({ order_id: id, ...JOB })
    await until(async () => (await leadOf(id))?.status === 'screened_out')
    await settle()
    expect(inputsOf('sorter')).toEqual([])
    const s = await screenOf(id)
    expect(s.hits.map((h) => h.criterion)).toEqual(['vacancy'])
    expect(s.hits[0]?.basis).toContain('разделы: «Обязанности»')
  })

  it('one that only looks like a vacancy goes on, loses 15 points and says so on the card', async () => {
    byRole = { ...byRole, scorer: scorerAnswer(75) }
    const id = orderId()
    await fake.emitOrder({ order_id: id, ...LIKE })
    await until(() => leadCards().length === 1)
    const s = await screenOf(id)
    expect(s).toMatchObject({ penalty: 15, hits: [] })
    expect(s.soft[0]?.criterion).toBe('vacancy')
    const [score] = await db.select().from(leadScore).where(eq(leadScore.leadId, id))
    expect(score?.score).toBe(60)
    expect(leadCards()[0]?.text).toContain('Похоже на вакансию (минус 15 баллов)')
  })

  it('and when the lost points take it under the threshold, it is dropped like any low score', async () => {
    byRole = { ...byRole, scorer: scorerAnswer(65) }
    const id = orderId()
    await fake.emitOrder({ order_id: id, ...LIKE })
    await until(async () => (await leadOf(id))?.status === 'scored_out')
    const [score] = await db.select().from(leadScore).where(eq(leadScore.leadId, id))
    expect(score?.score).toBe(50)
    expect(score?.reason).toContain('минус 15: похоже на вакансию')
  })
})
