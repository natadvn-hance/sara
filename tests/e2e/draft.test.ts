import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { event, lead, leadLabel, outbox, question, task } from '../../apps/core/src/db/schema'
import { saveProfile } from '../../apps/core/src/direction/profile'
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
const BODY = 'Понимаю, клинике важно быстро начать запись.\n\nКогда хотите открыть запись онлайн?'
const ANALYST = analystAnswer(BODY)
/** The body in the draft: no period at the end of a paragraph (rule 4). */
const CLEAN = 'Понимаю, клинике важно быстро начать запись\n\nКогда хотите открыть запись онлайн?'
/** 12:00 in Moscow: the greeting follows the hour (rule 5), so the tests fix it. */
const NOON = new Date('2026-10-26T09:00:00Z')
let moment = NOON
/** The sample order 90000001: client Ирина, budget «до 150 000 ₽». */
const DRAFT = `Ирина, добрый день!\n\n${CLEAN}`
/** Sara's note after a new text; the sample order 90000001 is «Сайт для стоматологической клиники». */
const SAVED = 'Записала новый текст отклика для «Сайт для стоматологической клиники»'
const NBSP = ' '
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let n = 0
const claudeLog = join(tmpdir(), `e2e-draft-claude-${process.pid}.log`)
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
const cards = () => tg.sent.filter((m) => m.reply_markup)
const button = (m: (typeof tg.sent)[number] | undefined, action: string) =>
  m?.reply_markup?.inline_keyboard.flat().find((b) => b.callback_data.endsWith(`:${action}`))
    ?.callback_data ?? ''
const leadOf = async (id: string) => (await db.select().from(lead).where(eq(lead.id, id)))[0]
const eventsOf = (type: string, id: string) =>
  db
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.type, type), eq(event.entityId, id)))
const ASK =
  'Пришли новый текст отклика на «Сайт для стоматологической клиники» ответом на это сообщение, текстом или голосом. Приветствие я добавлю сама. Цену услуги можно прислать отдельной строкой, например «цена 5000».'
const said = (t: string) => tg.sent.some((m) => m.text === t)
const editRequests = () =>
  db.select().from(question).where(eq(question.kind, 'edit_draft')).orderBy(question.askedAt)
/** Presses «Изменить» on the card and waits for Sara's request; returns the request's message id. */
async function pressEdit(card: (typeof tg.sent)[number] | undefined): Promise<number> {
  const before = (await editRequests()).length
  tg.pushPress(111, button(card, 'edit'))
  await until(async () => (await editRequests()).filter((q) => q.telegramMessageId).length > before)
  return (await editRequests()).at(-1)?.telegramMessageId ?? -1
}
const analystCalls = async () =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(event)
      .where(
        sql`${event.type} in ('model.called', 'model.failed') and ${event.payload}->>'role' = 'analyst'`,
      )
  )[0]?.n ?? 0

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
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-draft-')),
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
      now: () => moment,
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
  moment = NOON
  await rm(claudeLog, { force: true })
  byRole = { sorter: FIT, scorer: scorerAnswer(70), analyst: ANALYST }
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  tg.sent.length = 0
  tg.answers.length = 0
  tg.markups.length = 0
  fake.bids.length = 0
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'pipeline.leads', true, 'boris')
  await setSetting(db, 'outbound.bids', true, 'boris')
})

describe('the draft on the card', () => {
  it('FR-LEAD-6: a direction with a format and a case gives a draft with the case link, and the journal keeps the id only', async () => {
    await saveProfile(
      db,
      'hance-marketing',
      {
        reply_format: {
          parts: [{ id: 'understanding', title: 'Понимание', hint: 'Про ситуацию клиента' }],
          max_chars: 500,
          tone: [],
          examples: [],
          max_cases: 1,
        },
        cases: [
          {
            id: 'clinic_site',
            title: 'Сайт клиники',
            url: 'https://hance.example/cases/clinic',
            summary: 'Запись онлайн',
            tags: ['сайт'],
            show_when: 'Нужен сайт услуг',
            never_when: null,
          },
        ],
      },
      'boris',
    )
    byRole = { ...byRole, analyst: { ...ANALYST, case_ids: ['clinic_site'] } }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const link = 'Похожая работа: Сайт клиники, https://hance.example/cases/clinic'
    expect((await leadOf(id))?.draftText).toBe(`${DRAFT}\n\n${link}`)
    expect(cards()[0]?.text).toContain(link)
    const [drafted] = await eventsOf('lead.drafted', id)
    expect(drafted?.payload).toMatchObject({ drafted: true, cases: ['clinic_site'] })
    expect(JSON.stringify(drafted?.payload)).not.toContain('hance.example')
    // The Analyst was told the rules and was not given the link.
    const log = (await readFile(claudeLog, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { args: string[]; stdin: string })
    const call = log.find((c) => c.args.some((a) => a.endsWith('analyst/role.md')))
    expect(call?.stdin).toContain('clinic_site: Сайт клиники')
    expect(call?.stdin).not.toContain('hance.example')
  })

  it('FR-LEAD-6: the first card shows the bid as it will be sent: the case line is tidied like the rest', async () => {
    const dash = String.fromCharCode(0x2014)
    await saveProfile(
      db,
      'hance-marketing',
      {
        reply_format: {
          parts: [{ id: 'understanding', title: 'Понимание', hint: 'Про ситуацию клиента' }],
          max_chars: 500,
          tone: [],
          examples: [],
          max_cases: 1,
        },
        cases: [
          {
            id: 'clinic_site',
            title: `Сайт-визитка ${dash} для клиники`,
            url: 'https://hance.example/cases/clinic-site',
            summary: 'Запись онлайн',
            tags: ['сайт'],
            show_when: 'Нужен сайт услуг',
            never_when: null,
          },
        ],
      },
      'boris',
    )
    byRole = { ...byRole, analyst: { ...ANALYST, case_ids: ['clinic_site'] } }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const sent = 'Похожая работа: Сайт визитка для клиники, https://hance.example/cases/clinic-site'
    expect(cards()[0]?.text).toContain(sent)
    expect(cards()[0]?.text).not.toContain('Сайт-визитка')
    tg.pushPress(111, button(cards()[0], 'bid'))
    await until(() => fake.bids.length === 1)
    expect(fake.bids[0]?.text).toBe(`${DRAFT}\n\n${sent}`)
  })

  it('FR-LEAD-6: a direction with no format and no cases drafts exactly as before', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    expect((await leadOf(id))?.draftText).toBe(DRAFT)
    const [drafted] = await eventsOf('lead.drafted', id)
    expect(drafted?.payload).toMatchObject({ drafted: true, cases: [] })
  })

  it('FR-LEAD-6: a shown order comes as a card with the Analyst draft and the price', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    expect(cards()[0]?.text).toContain(`<blockquote>${DRAFT}</blockquote>`)
    expect(cards()[0]?.text).toContain(`услуга 90${NBSP}000${NBSP}₽`)
    expect(cards()[0]?.text).toContain(
      '<b>Хочет:</b> Боится долгого запуска\n<b>Риск:</b> Объём больше, чем звучит\n<b>Брать, если:</b> сроки понятны',
    )
    expect(await leadOf(id)).toMatchObject({
      draftText: DRAFT,
      draftPriceRub: 90000,
      draftAnalysis: {
        reading: ANALYST.reading,
        hidden_need: ANALYST.hidden_need,
        risk: ANALYST.risk,
        condition: ANALYST.condition,
      },
    })
    expect((await eventsOf('lead.drafted', id)).map((e) => e.payload)).toEqual([
      {
        drafted: true,
        analysis: true,
        chars: DRAFT.length,
        price_rub: 90000,
        attempts: 1,
        reason: null,
        cases: [],
      },
    ])
  })

  it('NFR-PRIV-2: a name inside the order text reaches no model, the card shows it back', async () => {
    byRole = {
      ...byRole,
      analyst: analystAnswer('Понимаю, [имя 1], вам важно быстро начать.\n\nКогда запуск?'),
    }
    await fake.emitOrder({
      order_id: orderId(),
      client_name: 'Ирина',
      text: 'Меня зовут Ирина, нужен сайт для клиники.',
    })
    await until(() => cards().length === 1)
    const stdins = (await readFile(claudeLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).stdin as string)
    // The Sorter, the Scorer and the Analyst each had the text.
    expect(stdins.length).toBeGreaterThanOrEqual(3)
    for (const stdin of stdins) expect(stdin).not.toContain('Ирина')
    expect(cards()[0]?.text).toContain(
      'Ирина, добрый день!\n\nПонимаю, Ирина, вам важно быстро начать\n\nКогда запуск?',
    )
  })

  it('FR-LEAD-7: without an Analyst answer the card comes without a draft', async () => {
    byRole = { ...byRole, analyst: { nothing: true } }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    expect(cards()[0]?.text).toContain('Черновика нет: Аналитик не ответил.')
    expect(cards()[0]?.text).not.toContain('<b>Хочет:</b>')
    expect(await leadOf(id)).toMatchObject({
      draftText: null,
      draftPriceRub: null,
      draftAnalysis: null,
    })
    expect((await eventsOf('lead.drafted', id)).map((e) => e.payload)).toEqual([
      {
        drafted: false,
        analysis: false,
        chars: null,
        price_rub: null,
        attempts: 1,
        reason: 'no_answer',
        cases: [],
      },
    ])
  })

  it('FR-LEAD-6: an order the Scorer dropped gets no draft call', async () => {
    byRole = { ...byRole, scorer: scorerAnswer(30) }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(async () => (await leadOf(id))?.status === 'scored_out')
    await new Promise((r) => setTimeout(r, 300))
    expect(await analystCalls()).toBe(0)
    expect(cards()).toHaveLength(0)
  })

  it('FR-LEAD-7: a card sent again carries the draft', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const [t] = await db.select().from(task).where(eq(task.entityId, id))
    await app.pipeline.resendCard(t?.id ?? '')
    await until(() => cards().length === 2)
    expect(cards()[1]?.text).toContain(`<blockquote>${DRAFT}</blockquote>`)
  })

  it('FR-LEAD-7: «Взял бы» brings a card with a draft', async () => {
    byRole = { ...byRole, scorer: scorerAnswer(50) }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(async () => (await leadOf(id))?.status === 'scored_out')
    await dailySummary({ db: app.db, notifier: app.bot.notifier }, summaryTime())
    await until(() => tg.sent.some((m) => m.text.startsWith('Сегодня отсеяла')))
    const summary = tg.sent.find((m) => m.text.startsWith('Сегодня отсеяла'))
    tg.pushPress(111, summary?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? '')
    await until(() => tg.answers.some((a) => a.text === 'Пишу черновик, пришлю карточку'))
    await until(() => cards().some((m) => button(m, 'bid') !== ''))
    expect(cards().find((m) => button(m, 'bid') !== '')?.text).toContain(
      `<blockquote>${DRAFT}</blockquote>`,
    )
    expect(await leadOf(id)).toMatchObject({ draftText: DRAFT, draftPriceRub: 90000 })
  })
})

describe('the order page name', () => {
  it('NFR-PRIV-2: the name the order page gave is hidden from the Analyst of a «Взял бы» draft', async () => {
    byRole = { ...byRole, scorer: scorerAnswer(50) }
    const id = orderId()
    // The board gave no name; the text says it, and so will the order page.
    await fake.emitOrder({
      order_id: id,
      client_name: '',
      text: 'Меня зовут Ольга Петрова, нужен сайт для клиники.',
    })
    await until(async () => (await leadOf(id))?.status === 'scored_out')
    await db
      .update(lead)
      .set({
        clientInfo: {
          name: 'Ольга Петрова',
          on_profi_since: null,
          phone_verified: null,
          reviews: null,
          review_tags: [],
        },
      })
      .where(eq(lead.id, id))
    await dailySummary({ db: app.db, notifier: app.bot.notifier }, summaryTime())
    await until(() => tg.sent.some((m) => m.text.startsWith('Сегодня отсеяла')))
    const summary = tg.sent.find((m) => m.text.startsWith('Сегодня отсеяла'))
    tg.pushPress(111, summary?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? '')
    await until(() => cards().some((m) => button(m, 'bid') !== ''))
    const analyst = (await readFile(claudeLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).stdin as string)
      .filter((stdin) => stdin.includes('Длина текста'))
    expect(analyst).toHaveLength(1)
    expect(analyst[0]).not.toContain('Ольга')
    expect(analyst[0]).not.toContain('Петрова')
  })
})

describe('the bid', () => {
  it('FR-LEAD-8: «Откликнуться» sends the draft and its price', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    tg.pushPress(111, button(cards()[0], 'bid'))
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    expect(fake.bids).toHaveLength(1)
    expect(fake.bids[0]).toMatchObject({ order_id: id, text: DRAFT, price_rub: 90000 })
  })

  it('FR-LEAD-7: «Откликнуться» without a draft asks for «Изменить» and records nothing', async () => {
    byRole = { ...byRole, analyst: { nothing: true } }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    tg.pushPress(111, button(cards()[0], 'bid'))
    await until(() => tg.answers.length === 1)
    expect(tg.answers[0]?.text).toBe('Сначала нажми «Изменить» и пришли текст отклика')
    await new Promise((r) => setTimeout(r, 300))
    expect(await db.select().from(outbox)).toHaveLength(0)
    expect(fake.bids).toHaveLength(0)
    const [t] = await db.select().from(task).where(eq(task.entityId, id))
    expect(t?.state).toBe('open')
  })
})

// Each case walks the whole bot path; on the Mac runner with two CI runs at once 5 seconds was too short.
describe('the pult', { timeout: 30000 }, () => {
  const NEW = 'Понимаю вашу задачу. Когда нужен запуск?'
  /** The owner's session for the pult's API: the password is set anew, the database was emptied. */
  async function owner(): Promise<string> {
    const r = await fetch(`${app.url}/api/setup/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'длинныйпароль1' }),
    })
    return (r.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  }
  const post = async (cookie: string, path: string, body: object) => {
    const r = await fetch(`${app.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    })
    return { status: r.status, body: (await r.json()) as { message?: string; error?: string } }
  }

  it('FR-LEAD-7: the pult saves a new text and price with no new card, and the bid goes with them', async () => {
    const cookie = await owner()
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const r = await post(cookie, `/api/leads/${id}/text`, { text: NEW, priceRub: 70000 })
    expect(r).toEqual({
      status: 200,
      body: {
        message: 'Записала новый текст и цену услуги для «Сайт для стоматологической клиники»',
      },
    })
    expect(cards()).toHaveLength(1)
    expect(await leadOf(id)).toMatchObject({
      draftText: `Ирина, добрый день!\n\n${NEW}`,
      draftPriceRub: 70000,
    })
    expect((await eventsOf('draft.edited', id)).map((e) => e.payload)).toEqual([
      { before: CLEAN, after: NEW, voice: false },
    ])
    tg.pushPress(111, button(cards()[0], 'bid'))
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    expect(fake.bids[0]).toMatchObject({ text: `Ирина, добрый день!\n\n${NEW}`, price_rub: 70000 })
    // Decided: the text is no longer edited.
    expect((await post(cookie, `/api/leads/${id}/text`, { text: NEW })).status).toBe(409)
  })

  it('FR-UI-6: a press in the pult marks the Telegram card, so no live button is left', async () => {
    const cookie = await owner()
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const [t] = await db
      .select()
      .from(task)
      .where(and(eq(task.entityId, id), eq(task.kind, 'lead_decision')))
    expect((await post(cookie, `/api/tasks/${t?.id}/skip`, {})).status).toBe(200)
    await until(() => tg.markups.some((m) => m.message_id === t?.telegramMessageId))
    expect(tg.markups.at(-1)?.reply_markup?.inline_keyboard).toEqual([
      [{ text: 'Решено в приложении: пропущено', callback_data: 'done' }],
    ])
  })
})

describe('«Изменить»', { timeout: 30000 }, () => {
  const NEW = 'Понимаю вашу задачу. Когда нужен запуск?'

  it('FR-LEAD-7: «Изменить» takes a new text by reply and brings an updated card', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const ask = await pressEdit(cards()[0])
    // The answer to the press may come a moment after the prompt message.
    await until(() => tg.answers.some((x) => x.text === 'Жду новый текст отклика'))
    expect(said(ASK)).toBe(true)
    tg.pushText(111, NEW, ask)
    await until(() => said(SAVED))
    expect(cards()).toHaveLength(2)
    expect(cards()[1]?.text).toContain(`<blockquote>Ирина, добрый день!\n\n${NEW}</blockquote>`)
    expect(cards()[1]?.text).toContain(`услуга 90${NBSP}000${NBSP}₽`)
    expect(await leadOf(id)).toMatchObject({
      draftText: `Ирина, добрый день!\n\n${NEW}`,
      draftPriceRub: 90000,
    })
    expect((await eventsOf('draft.edited', id)).map((e) => e.payload)).toEqual([
      { before: CLEAN, after: NEW, voice: false },
    ])
    const journal = await db.select({ p: event.payload }).from(event)
    expect(JSON.stringify(journal)).not.toContain('Ирина')
    tg.pushPress(111, button(cards()[1], 'bid'))
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    expect(fake.bids[0]).toMatchObject({
      text: `Ирина, добрый день!\n\n${NEW}`,
      price_rub: 90000,
    })
  })

  it('FR-LEAD-6: an edit longer than 500 with the greeting is refused and the next one is taken', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const ask = await pressEdit(cards()[0])
    tg.pushText(111, `Понимаю. ${'а'.repeat(590)}`, ask)
    // The greeting changes with the hour: the count is the one of the longest, the evening one, and says so at noon.
    await until(() =>
      said(
        'С вечерним приветствием выходит 621 знак, а Профи.ру принимает до 500. Пришли текст короче.',
      ),
    )
    expect((await leadOf(id))?.draftText).toBe(DRAFT)
    expect(cards()).toHaveLength(1)
    tg.pushText(111, NEW)
    await until(() => said(SAVED))
    expect((await leadOf(id))?.draftText).toBe(`Ирина, добрый день!\n\n${NEW}`)
  })

  it('FR-LEAD-6: in the evening the same too long edit is counted with the greeting Boris sees', async () => {
    moment = new Date('2026-10-26T15:00:00Z')
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const ask = await pressEdit(cards()[0])
    tg.pushText(111, `Понимаю. ${'а'.repeat(590)}`, ask)
    await until(() =>
      said('С приветствием выходит 621 знак, а Профи.ру принимает до 500. Пришли текст короче.'),
    )
  })

  it('FR-LEAD-7: after «Пропустить» a late edit changes nothing', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const ask = await pressEdit(cards()[0])
    tg.pushPress(111, button(cards()[0], 'skip'))
    await until(() => tg.answers.some((a) => a.text === 'Пропущено'))
    tg.pushText(111, NEW, ask)
    await until(() => said('Заявка уже решена, текст не поменяла'))
    expect(cards()).toHaveLength(1)
    expect((await leadOf(id))?.draftText).toBe(DRAFT)
    expect((await editRequests())[0]?.answeredAt).not.toBeNull()
    expect(await eventsOf('draft.edited', id)).toHaveLength(0)
  })

  it('FR-LEAD-7: a card without a draft gets one through «Изменить»', async () => {
    byRole = { ...byRole, analyst: { nothing: true } }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const ask = await pressEdit(cards()[0])
    tg.pushText(111, 'Сделаем сайт. Когда старт?', ask)
    await until(() => said(SAVED))
    expect(cards()[1]?.text).toContain(
      'Стоимость услуги: не указана. Без неё Профи.ру отклик не примет',
    )
    expect((await eventsOf('draft.edited', id)).map((e) => e.payload)).toEqual([
      { before: null, after: 'Сделаем сайт. Когда старт?', voice: false },
    ])
    // Without the «Стоимость услуги» the press asks for it (K2); the answer is the price.
    tg.pushPress(111, button(cards()[1], 'bid'))
    await until(() => tg.answers.some((a) => a.text === 'Жду цену услуги'))
    const asked = async () =>
      (await db.select().from(question).where(eq(question.kind, 'edit_price'))).find(
        (q) => q.telegramMessageId,
      )
    await until(async () => !!(await asked()))
    tg.pushText(111, '20000', (await asked())?.telegramMessageId ?? undefined)
    await until(() => said('Записала цену услуги для «Сайт для стоматологической клиники»'))
    tg.pushPress(111, button(cards()[2], 'bid'))
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    expect(fake.bids[0]).toMatchObject({
      text: 'Ирина, добрый день!\n\nСделаем сайт. Когда старт?',
      price_rub: 20000,
    })
  }, 15000)

  it('FR-LEAD-7: a reply to the first of two edit requests is taken', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    const first = await pressEdit(cards()[0])
    await pressEdit(cards()[0])
    tg.pushText(111, NEW, first)
    await until(() => said(SAVED))
    expect((await leadOf(id))?.draftText).toBe(`Ирина, добрый день!\n\n${NEW}`)
    // The second request is closed too: a later plain message does not rewrite the draft.
    expect((await editRequests()).map((q) => q.answeredAt !== null)).toEqual([true, true])
    // A plain message with nothing open goes to the Secretary (ADR-027): here the fake CLI's «Готово.».
    tg.pushText(111, 'спасибо')
    await until(() => said('Готово.'))
    expect((await leadOf(id))?.draftText).toBe(`Ирина, добрый день!\n\n${NEW}`)
    expect(cards()).toHaveLength(2)
  })

  it('FR-LEAD-7: a text without a reply, with an edit request and a «почему?» both waiting, is stored nowhere', async () => {
    byRole = { ...byRole, scorer: scorerAnswer(90) }
    const a = orderId()
    const b = orderId()
    await fake.emitOrder({ order_id: a, title: 'Сайт для кафе' })
    await until(() => cards().length === 1)
    await fake.emitOrder({ order_id: b, title: 'Реклама на радио' })
    await until(() => cards().length === 2)
    const ask = await pressEdit(cards()[0])
    tg.pushPress(111, button(cards()[1], 'skip'))
    await until(() =>
      tg.sent.some(
        (m) => m.text === 'Почему пропустил «Реклама на радио»? Напиши или скажи голосом.',
      ),
    )

    tg.pushText(111, NEW)
    await until(() => tg.sent.some((m) => m.text.startsWith('Не поняла')))
    expect(tg.sent.at(-1)?.text).toBe(
      'Не поняла, к какому моему вопросу это. Сейчас жду:\n- новый текст отклика на «Сайт для кафе»\n- почему пропустил «Реклама на радио»\nНажми «Ответить» на нужном моём сообщении и пришли текст ещё раз.',
    )
    expect((await leadOf(a))?.draftText).toBe(DRAFT)
    expect((await db.select().from(leadLabel).where(eq(leadLabel.leadId, b)))[0]?.reason).toBeNull()
    expect(cards()).toHaveLength(2)

    // A reply finds its place, and the note says whose text it was.
    tg.pushText(111, NEW, ask)
    await until(() => said('Записала новый текст отклика для «Сайт для кафе»'))
    expect((await leadOf(a))?.draftText).toBe(`Ирина, добрый день!\n\n${NEW}`)
    expect((await db.select().from(leadLabel).where(eq(leadLabel.leadId, b)))[0]?.reason).toBeNull()
  })

  it('FR-LEAD-7: «Изменить» on a decided card does nothing', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    tg.pushPress(111, button(cards()[0], 'skip'))
    await until(() => tg.answers.some((a) => a.text === 'Пропущено'))
    tg.pushPress(111, button(cards()[0], 'edit'))
    await until(() => tg.answers.some((a) => a.text === 'Уже сделано'))
    expect(await editRequests()).toHaveLength(0)
  })
})

describe('the laid-out card', () => {
  const razbor = () => tg.sent.filter((m) => m.text.startsWith('<b>Разбор:'))

  it('FR-LEAD-7: an order comes as an HTML card with the whole order text, the client and the link', async () => {
    const id = orderId()
    await fake.emitOrder({
      order_id: id,
      title: 'Сайт <для> клиники',
      text: 'Нужен сайт & запись <b>онлайн</b>.\nСрок: месяц.',
    })
    await until(() => cards().length === 1)
    const card = cards()[0]
    expect(card).toMatchObject({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    expect(card?.text.split('\n').slice(0, 2)).toEqual([
      '<b>🔔 Сайт &lt;для&gt; клиники</b>',
      '📍 Краснодар',
    ])
    expect(card?.text).toContain(`💰 до 150 000 ₽  ·  🧾 отклик 210${NBSP}₽`)
    expect(card?.text).toContain('👤 <b>Ирина</b>')
    expect(card?.text).toContain(
      '<blockquote expandable>Нужен сайт &amp; запись &lt;b&gt;онлайн&lt;/b&gt;.\nСрок: месяц.</blockquote>',
    )
    expect(
      card?.text.endsWith(
        `<a href="https://profi.ru/backoffice/n.php?o=${id}">Открыть заявку на Профи.ру</a>`,
      ),
    ).toBe(true)
    expect(
      card?.reply_markup?.inline_keyboard.flat().map((b) => b.callback_data.split(':')[2]),
    ).toEqual(['bid', 'razbor', 'edit', 'skip'])
  })

  it('FR-LEAD-7: «Разбор» sends the Analyst reading as its own message, again from the old card after the bid', async () => {
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    tg.pushPress(111, button(cards()[0], 'razbor'))
    await until(() => razbor().length === 1)
    await until(() => tg.answers.some((x) => x.text === 'Прислала разбор'))
    expect(razbor()[0]).toMatchObject({ parse_mode: 'HTML' })
    for (const part of Object.values(ANALYST.reading)) expect(razbor()[0]?.text).toContain(part)
    expect(razbor()[0]?.text).toContain(ANALYST.condition)
    expect(razbor()[0]?.reply_markup).toBeUndefined()
    expect((await db.select().from(task).where(eq(task.entityId, id)))[0]?.state).toBe('open')

    tg.pushPress(111, button(cards()[0], 'bid'))
    await until(() => tg.sent.some((m) => m.text.startsWith('✅ Отклик отправлен')))
    tg.pushPress(111, button(cards()[0], 'razbor'))
    await until(() => razbor().length === 2)
    expect(razbor()[1]?.text).toBe(razbor()[0]?.text)
    await until(() => tg.answers.some((x) => x.text === 'Прислала разбор'))
  })

  it('FR-LEAD-7: a long order text is cut on the card and comes whole with «Разбор»', async () => {
    const id = orderId()
    const text = `Начало заявки. ${'Нужно сделать много разных вещей. '.repeat(250)}Конец заявки.`
    await fake.emitOrder({ order_id: id, text })
    await until(() => cards().length === 1)
    expect(cards()[0]?.text).toContain('…</blockquote>')
    expect(cards()[0]?.text).not.toContain('Конец заявки.')
    expect(cards()[0]?.text).toContain('<b>✍️ Отклик</b>')
    tg.pushPress(111, button(cards()[0], 'razbor'))
    await until(() => razbor().length === 1)
    const all = tg.sent.filter((m) => !m.reply_markup && m.text.includes('<blockquote expandable>'))
    expect(all.map((m) => m.text).join('\n')).toContain('Конец заявки.')
  })

  it('FR-LEAD-7: an order the Analyst did not answer on still has «Разбор»: it says there is none', async () => {
    byRole = { ...byRole, analyst: { nothing: true } }
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 1)
    tg.pushPress(111, button(cards()[0], 'razbor'))
    await until(() => razbor().length === 1)
    expect(razbor()[0]?.text).toContain('Разбора для этой заявки нет')
    await until(() => tg.answers.some((x) => x.text === 'Прислала разбор'))
  })

  it('FR-LEAD-7: a first card that failed arrives once, plain, and its «Разбор» works', async () => {
    const id = orderId()
    // Telegram does not answer while the order is handled: the card cannot go out, the lead and its task stay.
    await app.bot.stop()
    try {
      await fake.emitOrder({ order_id: id })
      await until(
        async () =>
          (await db.select().from(event).where(eq(event.type, 'notify.failed'))).length === 1,
      )
    } finally {
      await app.bot.start(tg.token)
    }
    const [t] = await db.select().from(task).where(eq(task.entityId, id))
    expect(t?.telegramMessageId).toBeNull()
    expect(cards()).toHaveLength(0)
    // The wait for the decision ran out: the card that never reached Boris is delivered, once.
    await app.pipeline.onReminder(t?.id ?? '')
    await until(() => cards().length === 1)
    expect(cards()[0]?.text.startsWith('<b>🔔 ')).toBe(true)
    expect(cards()[0]?.text).not.toContain('Заявка ждёт решения')
    expect(cards()[0]?.parse_mode).toBe('HTML')
    expect(await eventsOf('card.sent', t?.id ?? '')).toMatchObject([{ payload: { via: 'resend' } }])
    expect(await eventsOf('task.reminded', t?.id ?? '')).toEqual([])
    // Boris has it now: the next wait sends nothing.
    await app.pipeline.onReminder(t?.id ?? '')
    await new Promise((r) => setTimeout(r, 300))
    expect(cards()).toHaveLength(1)
    tg.pushPress(111, button(cards()[0], 'razbor'))
    await until(() => razbor().length === 1)
  })
})
