import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { lead, leadLabel, leadScore } from '../../apps/core/src/db/schema'
import { activeRules, seedDirection } from '../../apps/core/src/direction/store'
import { createGateway, withoutLimitWait } from '../../apps/core/src/gateway/gateway'
import { maybePropose } from '../../apps/core/src/learning/proposals'
import { setSetting } from '../../apps/core/src/settings/store'
import { analystAnswer } from '../../apps/core/test/helpers/analyst'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { scorerAnswer } from '../../apps/core/test/helpers/scorer'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

/**
 * Sara learns from Boris's closes without his words (07.11.2026, docs/superpowers/specs/2026-11-07-learn-from-closes.md):
 * the short card guesses why, one press corrects it, the Scorer sees his decisions on similar orders, and a reason
 * that keeps coming back becomes a proposal he applies in one press.
 */
const ROOT = resolve(import.meta.dirname, '../..')
const FIT = { verdict: 'fit', reason: 'Нужен сайт', tags: ['сайт'], confidence: 0.9 }
const ANALYST = analystAnswer('Понимаю задачу.\n\nКогда запуск?', 30000)
const ACC = 'hance-marketing'
const { db, close } = openTestDb()

let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp
let dir: string
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
const cards = () => tg.sent.filter((m) => m.reply_markup && m.text.includes('🔔'))
const buttonOf = (m: (typeof tg.sent)[number] | undefined, suffix: string) =>
  m?.reply_markup?.inline_keyboard.flat().find((b) => b.callback_data.endsWith(suffix))
/** The input the fake Claude got for `role` in its calls, oldest first. */
async function inputsOf(role: string): Promise<string[]> {
  const raw = await readFile(join(dir, 'claude.log'), 'utf8').catch(() => '')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args: string[]; stdin: string })
    .filter((c) => c.args.some((a) => a.endsWith(`${role}/role.md`)))
    .map((c) => c.stdin)
}

/** A new order, its card, and «Закрыть заявку» on it; waits until the card is folded. */
async function closeOne(): Promise<string> {
  const id = orderId()
  const before = cards().length
  await fake.emitOrder({ order_id: id })
  await until(() => cards().length === before + 1)
  const edits = tg.edited.length
  tg.pushPress(111, buttonOf(cards().at(-1), ':skip')?.callback_data ?? '')
  await until(() => tg.edited.length > edits)
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
  dir = await mkdtemp(join(tmpdir(), 'e2e-closes-'))
  app = await startApp(
    {
      ...loadConfig({}),
      databaseUrl: testDatabaseUrl(),
      dataDir: dir,
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
        FAKE_CLAUDE_ARGS_LOG: join(dir, 'claude.log'),
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
  byRole = { analyst: ANALYST, sorter: FIT, scorer: scorerAnswer(70) }
  await resetDb(db)
  await seedDirection(db, ACC)
  tg.sent.length = 0
  tg.edited.length = 0
  tg.answers.length = 0
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'pipeline.leads', true, 'boris')
})

describe('Sara learns from closed cards (07.11.2026)', { timeout: 60000 }, () => {
  it('the closed card guesses why, with reason buttons; one press makes the reason his and the buttons go', async () => {
    const id = await closeOne()
    const folded = tg.edited.at(-1)
    expect(folded?.text.split('\n').slice(0, 2)).toEqual([
      '<b>📁 Заявка закрыта</b> · Сайт для стоматологической клиники',
      '<i>Похоже, сайт, а не маркетинг</i>',
    ])
    const row = folded?.reply_markup?.inline_keyboard ?? []
    expect(row.map((r) => r.map((b) => b.text))).toEqual([
      ['Не наш профиль', 'Бюджет', 'Клиент', 'Другое'],
    ])
    const edits = tg.edited.length
    tg.pushPress(111, row[0]?.find((b) => b.text === 'Бюджет')?.callback_data ?? '')
    await until(() => tg.answers.some((a) => a.text === 'Записала: маленький бюджет'))
    await until(() => tg.edited.length > edits)
    expect(tg.edited.at(-1)?.text).toContain('<i>Причина: маленький бюджет</i>')
    expect(tg.edited.at(-1)?.reply_markup).toEqual({ inline_keyboard: [] })
    const [l] = await db.select().from(leadLabel).where(eq(leadLabel.leadId, id))
    expect(l).toMatchObject({
      label: 'no',
      reasonCode: 'budget',
      reasonBy: 'boris',
      guessCode: 'site',
    })
  })

  it('the Scorer sees his decisions on similar orders, and the next card says how he decided them', async () => {
    const first = await closeOne()
    await closeOne()
    const id = orderId()
    await fake.emitOrder({ order_id: id })
    await until(() => cards().length === 3)
    expect(cards()[2]?.text).toContain('🧭 Похожие ты закрывал 2 из 2 (сайт, а не маркетинг)')
    const input = (await inputsOf('scorer')).at(-1) ?? ''
    expect(input).toContain('Решения Бориса по похожим заказам')
    expect(input).toContain(
      '- «Сайт для стоматологической клиники» (Создание сайтов): закрыл, похоже: сайт, а не маркетинг',
    )
    const [s] = await db.select().from(leadScore).where(eq(leadScore.leadId, id))
    const items =
      (s?.precedents as { items: { id: string; label: string }[] } | undefined)?.items ?? []
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.label)).toEqual(['no', 'no'])
    expect(items.map((i) => i.id)).toContain(first)
    // What the precedents keep holds no order title or client.
    expect(JSON.stringify(s?.precedents)).not.toContain('Сайт')
    expect((await db.select().from(lead).where(eq(lead.id, id)))[0]?.status).toBe('queued')
  })

  it('five closes for one reason bring a proposal in Telegram that names it, and «Применить» makes the new rules', async () => {
    for (let i = 0; i < 5; i++) await closeOne()
    const active = await activeRules(db, ACC)
    const gateway = withoutLimitWait(
      createGateway({
        db,
        secrets: app.secrets,
        claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
        rolesDir: join(ROOT, 'roles'),
        dataDir: dir,
        extraEnv: {
          FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
            'rules-proposer': {
              summary: 'Сайты без маркетинга отсеивать строже',
              why: 'Ты закрывал заказы на одни сайты',
              rules: { ...active.rules, threshold: active.rules.threshold + 5 },
            },
            scorer: scorerAnswer(60),
          }),
        },
      }),
    )
    expect(await maybePropose({ db, gateway, notifier: app.bot.notifier }, ACC, new Date())).toBe(
      'asked',
    )
    await until(() => tg.sent.some((m) => m.text.startsWith('Предлагаю поправку правил')))
    const msg = tg.sent.find((m) => m.text.startsWith('Предлагаю поправку правил'))
    expect(msg?.text).toContain('Повод: 5 раз закрыл с причиной «сайт, а не маркетинг»')
    tg.pushPress(111, buttonOf(msg, ':apply')?.callback_data ?? '')
    await until(() =>
      tg.answers.some((a) => a.text === `Применила, теперь правила v${active.version + 1}`),
    )
    expect((await activeRules(db, ACC)).rules.threshold).toBe(active.rules.threshold + 5)
  })
})
