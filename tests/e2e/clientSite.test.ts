import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { event, lead } from '../../apps/core/src/db/schema'
import { seedDirection } from '../../apps/core/src/direction/store'
import { setSetting } from '../../apps/core/src/settings/store'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { scorerAnswer } from '../../apps/core/test/helpers/scorer'
import { dentalSite, fakeSiteFetch } from '../../apps/core/test/site/fakeSite'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

const ROOT = resolve(import.meta.dirname, '../..')
const FIT = { verdict: 'fit', reason: 'Нужен сайт', tags: ['сайт'], confidence: 0.9 }
const NOON = new Date('2026-10-26T09:00:00Z')
const BRIEF = {
  business: 'Стоматологическая клиника в Краснодаре',
  audience: 'Семьи с детьми',
  offer: 'Лечение, имплантация',
  seen: ['формы заявки нет, только телефон'],
  link: 'Заказ про заявки, а заявку можно оставить только звонком',
  hooks: ['заявку можно оставить только по телефону'],
  guesses: [],
  summary: 'Стоматология в Краснодаре на Tilda, заявка только по телефону',
}
const BODY =
  'Посмотрел ваш сайт: заявку можно оставить только по телефону.\n\nКак сейчас приходят обращения?'
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let n = 0
let site = fakeSiteFetch(dentalSite())
const claudeLog = join(tmpdir(), `e2e-site-claude-${process.pid}.log`)
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
const cards = () => tg.sent.filter((m) => m.reply_markup)
const leadOf = async (id: string) => (await db.select().from(lead).where(eq(lead.id, id)))[0]
const claudeCalls = async (role: string) =>
  (await readFile(claudeLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args: string[]; stdin: string })
    .filter((c) => c.args.some((a) => a.endsWith(`${role}/role.md`)))

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
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-site-')),
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
        FAKE_CLAUDE_ARGS_LOG: claudeLog,
      }),
      retryDelaysMs: [50, 50, 50, 50, 50],
      learningTickMs: 3_600_000,
      notifyRetry: { maxAttempts: 4, intervalSeconds: 0.5 },
      now: () => NOON,
      siteFetch: (url) => site.fetchPage(url),
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
  byRole = {
    sorter: FIT,
    scorer: scorerAnswer(70),
    analyst: analystAnswer(BODY),
    'site-reader': BRIEF,
  }
  site = fakeSiteFetch(dentalSite())
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  tg.sent.length = 0
  tg.answers.length = 0
  tg.markups.length = 0
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'pipeline.leads', true, 'boris')
  await setSetting(db, 'outbound.bids', true, 'boris')
})

describe("an order that names the client's site", () => {
  it('FR-SITE-25: the site is read before the bid, the Analyst builds on it, the card has the site line, the journal no address', async () => {
    const id = orderId()
    await fake.emitOrder({
      order_id: id,
      text: 'Нужно больше заявок для стоматологии. Мой сайт ulybka-plus.ru, заявок с него почти нет.',
    })
    await until(() => cards().length === 1)

    expect((await leadOf(id))?.clientSite).toMatchObject({
      own: {
        domain: 'ulybka-plus.ru',
        status: 'read',
        cms: 'tilda',
        brief: { summary: BRIEF.summary },
      },
    })
    expect(site.calls.length).toBe(4)

    // The model read the site first (the cheap one), then the Analyst got its summary in the input.
    const reader = await claudeCalls('site-reader')
    expect(reader).toHaveLength(1)
    const analyst = (await claudeCalls('analyst'))[0]
    expect(analyst?.stdin).toContain('Сайт клиента:')
    expect(analyst?.stdin).toContain(
      'Детали, которые можно назвать клиенту: заявку можно оставить только по телефону',
    )
    expect(analyst?.stdin).not.toContain('ulybka-plus.ru')

    // The card: the site line with the summary.
    expect(cards()[0]?.text).toContain(`🌐 <b>Сайт клиента:</b> ulybka-plus.ru · ${BRIEF.summary}`)
    // The bid is the Analyst's text with the detail of the site.
    expect((await leadOf(id))?.draftText).toContain(
      'Посмотрел ваш сайт: заявку можно оставить только по телефону',
    )

    const [ev] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, 'lead.site_read'), eq(event.entityId, id)))
    expect(ev?.payload).toMatchObject({ status: 'read', cms: 'tilda', brief: true })
    expect(JSON.stringify(ev?.payload)).not.toContain('ulybka')
  })

  it('FR-SITE-26: the site does not open: the bid is written as usual, and the card says «сайт не открылся»', async () => {
    site = fakeSiteFetch({ 'ulybka-plus.ru': 'timeout' })
    const id = orderId()
    await fake.emitOrder({ order_id: id, text: 'Нужны заявки. Сайт: https://ulybka-plus.ru' })
    await until(() => cards().length === 1)
    expect(cards()[0]?.text).toContain('🌐 <b>Сайт клиента:</b> ulybka-plus.ru · сайт не открылся')
    expect((await leadOf(id))?.draftText).toBeTruthy()
    expect(await claudeCalls('site-reader')).toHaveLength(0)
    const analyst = (await claudeCalls('analyst'))[0]
    expect(analyst?.stdin).toContain('Сайт клиента не открылся')
  })

  it('FR-SITE-27: no site in the order: no read, no site model call, no line on the card', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id, text: 'Нужна маркетинговая стратегия для кафе.' })
    await until(() => cards().length === 1)
    expect(site.calls).toHaveLength(0)
    expect(await claudeCalls('site-reader')).toHaveLength(0)
    expect((await leadOf(id))?.clientSite).toBeNull()
    expect(cards()[0]?.text).not.toContain('🌐')
    expect((await claudeCalls('analyst'))[0]?.stdin).not.toContain('Сайт клиента')
  })

  it('FR-SITE-2: an example the client likes is on the card as an example, its first page is looked at, never taken for his own site', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id, text: 'Нужен сайт для кафе, хочу как у apple.com.' })
    await until(() => cards().length === 1)
    // Only its first page is asked for.
    expect(site.calls).toEqual(['https://apple.com'])
    expect(cards()[0]?.text).toContain('🔗 Пример, который нравится клиенту: apple.com')
    expect(cards()[0]?.text).not.toContain('🌐')
  })
})
