import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AnalyticsView,
  ConvList,
  ConvView,
  formatRub,
  LeadQueue,
  LeadView,
  MindRecordView,
  MindView,
  newEventId,
  SettingsView,
  SystemView,
  type TaskAction,
  TodayView,
} from '@sara/shared'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/client'
import {
  account,
  chatMessage,
  conversation,
  convTurn,
  deal,
  event,
  lead,
  leadScore,
  mindProposal,
  modelCall,
  question,
  setting,
  task,
} from '../src/db/schema'
import { funnelStage } from '../src/pult/analytics'
import { backupPart } from '../src/pult/system'
import { getSetting } from '../src/settings/store'
import { buildTestApp, type TestApp } from './helpers/app'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)

let t: TestApp
let presses: { taskId: string; action: TaskAction; source?: string; reason?: string | null }[] = []
let edits: { taskId: string; text: string | null; priceRub: number | null }[] = []
const LEAD = '95000001'
const LEAD_TASK = '11111111-1111-4111-8111-111111111111'
const CONV = '22222222-2222-4222-8222-222222222222'
const DRAFT_TASK = '33333333-3333-4333-8333-333333333333'

/** Made-up data only: one account, a lead waiting with its score and draft, a client with a draft reply. */
async function seed(d: Db) {
  const now = new Date()
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString()
  await d.insert(account).values({
    id: 'hance-marketing',
    title: 'Hance маркетинг',
    egressIp: '127.0.0.1',
    loginState: 'alive',
    balanceRub: 1200,
    balanceAt: ago(4),
  })
  await d.insert(lead).values({
    id: LEAD,
    accountId: 'hance-marketing',
    title: 'Стратегия продвижения для студии керамики',
    category: 'Маркетинг',
    city: 'Краснодар',
    text: 'Нужна стратегия на полгода, сейчас продажи только через знакомых.',
    clientName: 'Вероника',
    budgetText: 'до 60 000 ₽',
    bidPriceRub: 240,
    seenAt: ago(25),
    status: 'queued',
    correlationId: newEventId(),
    draftText: 'Вероника, добрый день! Если я правильно понял, то...',
    draftPriceRub: 40000,
    draftAnalysis: {
      reading: {
        said: 'стратегия',
        layers: 'нет системы',
        wants: 'поток заказов',
        who: 'владелица',
        risks: 'мало денег',
        job: 'рост',
      },
      hidden_need: 'хочет поток заказов, а не документ',
      risk: 'бюджет может не выдержать',
      condition: 'брать, если готова к созвону',
      text: 'x',
      price_rub: 40000,
    },
    clientInfo: {
      name: 'Вероника',
      on_profi_since: 'На Профи.ру с 2022',
      phone_verified: true,
      reviews: { positive: 3, negative: 0 },
      review_tags: [],
    },
  })
  await d.insert(leadScore).values({
    id: newEventId(),
    leadId: LEAD,
    version: 1,
    score: 72,
    decision: 'card',
    stopFactor: null,
    redFlags: [],
    axes: [{ id: 'fit', score: 80, why: 'стратегия, наш профиль' }],
    reason: 'стратегия для малого бизнеса',
    confidence: 0.8,
    model: 'sonnet',
  })
  await d
    .insert(task)
    .values({ id: LEAD_TASK, kind: 'lead_decision', entityKind: 'lead', entityId: LEAD })
  await d.insert(conversation).values({
    id: CONV,
    accountId: 'hance-marketing',
    chatId: 'chat-1',
    orderId: LEAD,
    origin: 'sara',
  })
  await d.insert(chatMessage).values({
    id: newEventId(),
    accountId: 'hance-marketing',
    chatId: 'chat-1',
    orderId: LEAD,
    platformMessageId: 'm1',
    side: 'client',
    author: 'client',
    authorBasis: 'side',
    text: 'Здравствуйте! Сколько стоит?',
    sentAt: ago(10),
    source: 'live',
    conversationId: CONV,
  })
  await d.insert(convTurn).values({
    id: 'turn-1',
    conversationId: CONV,
    anchorMessageId: 'm1',
    text: 'Вероника, добрый день! Цена зависит от объёма, давайте созвонимся.',
    understanding: { why: 'клиент спросил цену', tone: 'neutral' },
    state: 'carded',
  })
  await d
    .insert(task)
    .values({ id: DRAFT_TASK, kind: 'conv_draft', entityKind: 'conv_turn', entityId: 'turn-1' })
  const ev = (
    type: string,
    entityKind: string,
    entityId: string,
    payload: object,
    min: number,
  ) => ({
    id: newEventId(),
    type,
    v: 1,
    entityKind,
    entityId,
    accountId: 'hance-marketing',
    actor: 'sara',
    occurredAt: ago(min),
    correlationId: newEventId(),
    payload,
  })
  // An earlier lead with a bid and a reply: the analytics have one client in talks.
  await d.insert(lead).values({
    id: '95000002',
    accountId: 'hance-marketing',
    title: 'Маркетинг для салона',
    category: 'Маркетинг',
    city: 'Москва',
    text: 'Нужен маркетолог',
    clientName: 'Арина',
    bidPriceRub: 180,
    seenAt: ago(300),
    status: 'bid_sent',
    correlationId: newEventId(),
  })
  await d.insert(deal).values({
    id: newEventId(),
    leadId: '95000002',
    accountId: 'hance-marketing',
    stage: 'talking',
  })
  await d
    .insert(event)
    .values([
      ev('lead.scored', 'lead', LEAD, { score: 72, decision: 'card', version: 1 }, 24),
      ev('bid.sent', 'lead', '95000002', { spent_rub: 180 }, 200),
      ev('spend.recorded', 'lead', '95000002', { amount_rub: 180 }, 200),
      ev('conv.turn_drafted', 'conversation', CONV, {}, 5),
    ])
  await d.execute(sql`insert into core.mind_index (record_id, path, type, scope, title, body, version, mind_version, tsv)
    values ('K-001', 'mind/knowledge/price.md', 'knowledge', 'common', 'Как говорим о цене', 'Цену называем вилкой.', 2, 'abc123',
      to_tsvector('russian', 'Цену называем вилкой'))`)
  await d.insert(mindProposal).values({
    id: newEventId(),
    path: 'mind/knowledge/new.md',
    content: '---\ntype: knowledge\n---\nНовая запись',
    kind: 'knowledge',
    source: 'turn',
  })
}

beforeEach(async () => {
  await resetDb(db)
  presses = []
  edits = []
  t = await buildTestApp(db, {}, undefined, {
    onPress: async (p) => {
      presses.push(p)
      return 'Принято.'
    },
    saveBidText: async (p) => {
      edits.push(p)
      return { saved: true, message: 'Записала.' }
    },
  })
  await t.app.inject({
    method: 'POST',
    url: '/api/setup/password',
    payload: { password: 'длинныйпароль1' },
  })
  await seed(db)
})
afterEach(() => t.close())

const get = async (url: string) => {
  const r = await t.app.inject({ method: 'GET', url, headers: { cookie: t.cookie() } })
  return { status: r.statusCode, body: r.json() as unknown, headers: r.headers }
}
const post = async (url: string, payload: object = {}) => {
  const r = await t.app.inject({ method: 'POST', url, payload, headers: { cookie: t.cookie() } })
  return {
    status: r.statusCode,
    body: r.json() as { message?: string; error?: string; code?: string },
  }
}

describe('the pult screens read the core', () => {
  it('FR-UI-1: without the owner session every screen answers 401', async () => {
    for (const url of [
      '/api/today',
      '/api/inbox',
      '/api/notices',
      '/api/journal',
      '/api/search?q=ab',
      '/api/leads',
      '/api/conversations',
      '/api/analytics',
      '/api/mind',
      '/api/settings',
      '/api/system',
    ]) {
      const r = await t.app.inject({ method: 'GET', url })
      expect(r.statusCode, url).toBe(401)
    }
  })

  it('FR-UI-1: «Сегодня» shows what waits, the wallet, the day against the limits and the feed', async () => {
    const r = await get('/api/today?period=30')
    expect(r.status).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    const v = TodayView.parse(r.body)
    expect(v.waiting.leads).toBe(1)
    expect(v.waiting.drafts).toBe(1)
    expect(v.waiting.items.map((i) => i.kind)).toEqual(['leads', 'draft'])
    expect(v.waiting.items[1]?.title).toContain('Вероника')
    expect(v.wallet.balanceRub).toBe(1200)
    expect(v.day.bidsCap).toBe(10)
    // Bids are paused by default: the state says so, and the drafts mode is in the detail.
    expect(v.state.text).toBe('Отклики на паузе')
    expect(v.feed.map((f) => f.text)).toContain(
      'Оценила «Стратегия продвижения для студии керамики»: балл 72',
    )
    expect(v.period.bids).toBe(1)
    expect(v.period.spentRub).toBe(180)
    expect(v.period.replied).toBe(1)
  })

  it('FR-LEAD-10, FR-UI-5: the queue by value and a lead with its score, разбор, price range and obstacles', async () => {
    const q = LeadQueue.parse((await get('/api/leads')).body)
    expect(q.queue).toHaveLength(1)
    expect(q.queue[0]).toMatchObject({ id: LEAD, taskId: LEAD_TASK, score: 72, feeRub: 240 })
    expect(q.paused).toContain('паузе')
    const v = LeadView.parse((await get(`/api/leads/${LEAD}`)).body)
    expect(v.score?.value).toBe(72)
    expect(v.score?.axes[0]?.score).toBe(80)
    expect(v.analysis?.hiddenNeed).toBe('хочет поток заказов, а не документ')
    expect(v.analysis?.reading.map((x) => x.label)).toContain('Чего хочет на самом деле')
    expect(v.bid).toMatchObject({ priceFromRub: 40000, priceToRub: 60000, limit: 500 })
    expect(v.lead.client?.since).toBe('На Профи.ру с 2022')
    expect(v.obstacles).toContain('отклики на паузе')
    expect((await get('/api/leads/nope')).status).toBe(404)
  })

  it('FR-CONV-11: a client with the chat and the open draft that «Отправить» would send', async () => {
    const list = ConvList.parse((await get('/api/conversations')).body)
    expect(list.rows[0]).toMatchObject({ id: CONV, name: 'Вероника', group: 'waiting' })
    expect(list.drafting).toContain('старая Сара')
    const v = ConvView.parse((await get(`/api/conversations/${CONV}`)).body)
    expect(v.messages[0]?.text).toBe('Здравствуйте! Сколько стоит?')
    expect(v.draft).toMatchObject({
      taskId: DRAFT_TASK,
      kind: 'reply',
      why: 'клиент спросил цену',
      tone: 'спокойный',
    })
    expect(v.sendHold).toContain('старая Сара')
  })

  it("FR-ANL-5, FR-ANL-6: Boris's three tables from the journal and the deals", async () => {
    const v = AnalyticsView.parse(
      (await get(`/api/analytics?year=${new Date().getFullYear()}`)).body,
    )
    expect(v.clients).toHaveLength(1)
    expect(v.clients[0]).toMatchObject({
      client: 'Арина',
      stage: 'Переговоры',
      spendRub: 180,
      dealRub: null,
    })
    expect(v.funnel.find((f) => f.stage === 'Отклик')).toMatchObject({ count: 1, share: 100 })
    expect(v.funnel.find((f) => f.stage === 'Переговоры')?.count).toBe(1)
    expect(v.months).toHaveLength(13)
    expect(v.months.at(-1)).toMatchObject({
      month: 'ИТОГО',
      bids: 1,
      won: 0,
      cacRub: null,
      spendRub: 180,
    })
  })

  it('FR-ANL-5: a deal stage maps to one of the five funnel stages', () => {
    expect(funnelStage('bid_sent')).toBe('Отклик')
    expect(funnelStage('call_proposed')).toBe('Переговоры')
    expect(funnelStage('call_done')).toBe('В работе')
    expect(funnelStage('won')).toBe('Закрыта')
    expect(funnelStage('dormant')).toBe('Отвалился')
  })

  it('FR-MIND-1: the mind by its parts, proposals and a record, read only', async () => {
    const v = MindView.parse((await get('/api/mind')).body)
    expect(v.groups.find((g) => g.type === 'knowledge')?.records[0]?.title).toBe(
      'Как говорим о цене',
    )
    expect(v.proposals[0]?.preview).toBe('Новая запись')
    const r = MindRecordView.parse((await get('/api/mind/K-001')).body)
    expect(r.record.body).toBe('Цену называем вилкой.')
    expect((await get('/api/mind/K-404')).status).toBe(404)
  })

  it('FR-SET-5, FR-OPS-3: «Здоровье» has the node, the session, the link, the backups and the Claude limit', async () => {
    const v = SystemView.parse((await get('/api/system')).body)
    expect(v.parts.map((p) => p.id)).toEqual([
      'db',
      'node',
      'telegram',
      'claude',
      'session',
      'link',
      'backup',
    ])
    expect(v.parts.find((p) => p.id === 'backup')?.text).toBe('Ядро не видит журнал копий')
    expect(v.claude.limited).toBe(false)
    expect(v.accounts[0]).toMatchObject({ id: 'hance-marketing', balanceRub: 1200 })
  })

  it('FR-SET-5: the backup line reads the last dump and the restore check from the host log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'backup-'))
    const log = join(dir, 'sara-backup.log')
    await writeFile(
      log,
      '2026-10-28T01:00:00Z dump sara-1.age 123 bytes\n2026-10-28T02:00:00Z restore ok: x\n',
    )
    const ok = await backupPart(log, new Date('2026-10-28T09:00:00Z'))
    expect(ok).toMatchObject({ tone: 'ok', at: '2026-10-28T01:00:00Z' })
    expect(ok.text).toContain('проверка восстановления')
    const old = await backupPart(log, new Date('2026-10-30T09:00:00Z'))
    expect(old.tone).toBe('bad')
  })
})

describe('the pult acts only through the Telegram buttons', () => {
  it('FR-UI-6, ST-M7-04: a bid is held at the price Boris saw, a changed price is refused', async () => {
    expect((await post(`/api/tasks/${LEAD_TASK}/bid`)).status).toBe(400)
    const changed = await post(`/api/tasks/${LEAD_TASK}/bid`, { expectedFeeRub: 200 })
    expect(changed.status).toBe(409)
    expect(changed.body.error).toBe(
      `Цена изменилась: было ${formatRub(200)}, стало ${formatRub(240)}. Нажми ещё раз.`,
    )
    expect(presses).toEqual([])
    // Without the bid hold wired the pult says Sara is starting; the hold itself is tested in leads/hold.test.ts.
    expect((await post(`/api/tasks/${LEAD_TASK}/bid`, { expectedFeeRub: 240 })).status).toBe(503)
    expect(presses).toEqual([])
  })

  it('FR-CONV-11: «Отправить» on a draft is the card press; actions of another kind are refused', async () => {
    expect((await post(`/api/tasks/${DRAFT_TASK}/send`)).status).toBe(200)
    expect(presses).toEqual([{ taskId: DRAFT_TASK, action: 'send', source: 'pult', reason: null }])
    expect((await post(`/api/tasks/${DRAFT_TASK}/bid`, { expectedFeeRub: 240 })).status).toBe(400)
    expect((await post(`/api/tasks/${LEAD_TASK}/send`)).status).toBe(400)
    expect((await post(`/api/tasks/${LEAD_TASK}/nonsense`)).status).toBe(400)
    expect((await post('/api/tasks/not-a-uuid/bid')).status).toBe(404)
  })

  it('FR-OPS-1: limits change freely, a pause only toward off, the switch keys never', async () => {
    expect((await post('/api/settings/money.daily_bids', { value: 7 })).status).toBe(200)
    expect(await getSetting(db, 'money.daily_bids')).toBe(7)
    expect((await post('/api/settings/money.daily_budget_rub', { value: null })).status).toBe(200)
    expect((await post('/api/settings/money.daily_bids', { value: -1 })).status).toBe(400)
    await db.insert(setting).values({ key: 'outbound.bids', value: true, changedBy: 'system' })
    expect((await post('/api/settings/outbound.bids', { value: false })).status).toBe(200)
    expect(await getSetting(db, 'outbound.bids')).toBe(false)
    expect((await post('/api/settings/outbound.bids', { value: true })).status).toBe(403)
    expect((await post('/api/settings/conv.v1_writes', { value: false })).status).toBe(403)
    expect((await post('/api/settings/pipeline.leads', { value: true })).status).toBe(403)
    expect((await post('/api/settings/no.such', { value: 1 })).status).toBe(404)
    const v = SettingsView.parse((await get('/api/settings')).body)
    expect(v.groups.flatMap((g) => g.rows).find((r) => r.key === 'money.daily_bids')?.value).toBe(7)
    expect(v.history[0]).toMatchObject({ key: 'outbound.bids', by: 'boris', value: false })
  })
})

describe('the pult on the live data (28.10.2026)', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
  const ev = (type: string, entityKind: string, entityId: string, payload: object, m: number) => ({
    id: newEventId(),
    type,
    v: 1,
    entityKind,
    entityId,
    accountId: 'hance-marketing',
    actor: 'sara',
    occurredAt: minutesAgo(m),
    correlationId: newEventId(),
    payload,
  })

  it('FR-LEAD-9: the wallet is the newer of the account row and the balance the node last reported', async () => {
    await db
      .insert(event)
      .values(ev('profi.balance_changed', 'account', 'hance-marketing', { balance_rub: 4415 }, 1))
    const v = TodayView.parse((await get('/api/today')).body)
    expect(v.wallet.balanceRub).toBe(4415)
  })

  it('FR-UI-6: a question names its order and leads to it; one left unanswered for days is not waited for', async () => {
    await db.insert(question).values([
      { id: newEventId(), kind: 'edit_draft', entityId: LEAD_TASK, askedAt: minutesAgo(3) },
      { id: newEventId(), kind: 'why_skip', entityId: LEAD, askedAt: minutesAgo(3 * 24 * 60) },
    ])
    const items = TodayView.parse((await get('/api/today')).body).waiting.items.filter(
      (i) => i.kind === 'question',
    )
    expect(items).toEqual([
      expect.objectContaining({
        title: 'Сара ждёт новый текст отклика',
        sub: '«Стратегия продвижения для студии керамики», ответь в Telegram',
        link: `/leads/${LEAD}`,
      }),
    ])
  })

  it('FR-UI-1: a lead card in the feed names its order, not «разговор»', async () => {
    await db.insert(event).values(ev('card.sent', 'task', LEAD_TASK, { via: 'first' }, 1))
    const feed = TodayView.parse((await get('/api/today')).body).feed
    expect(feed.map((f) => f.text)).not.toContain('Изменена настройка setup.progress')
    expect(feed.find((f) => f.text.startsWith('Прислала'))).toMatchObject({
      text: 'Прислала тебе карточку «Стратегия продвижения для студии керамики»',
      link: `/leads/${LEAD}`,
    })
  })

  it("FR-CONV-11: a chat begun by old Sara is named from our greeting, Profi.ru's lines are its own", async () => {
    const id = '44444444-4444-4444-8444-444444444444'
    await db
      .insert(conversation)
      .values({ id, accountId: 'hance-marketing', chatId: '88690561', origin: 'v1' })
    const msg = (n: string, side: string, author: string, text: string, m: number) => ({
      id: newEventId(),
      accountId: 'hance-marketing',
      chatId: '88690561',
      platformMessageId: n,
      side,
      author,
      authorBasis: 'side',
      text,
      sentAt: minutesAgo(m),
      source: 'live',
      conversationId: id,
    })
    await db
      .insert(chatMessage)
      .values([
        msg('d1', 'specialist', 'sara_v1', 'Дарья, добрый день! Заказ по-прежнему актуален?', 30),
        msg('d2', 'specialist', 'system', 'Вернули на баланс 137 руб.', 20),
      ])
    const row = ConvList.parse((await get('/api/conversations')).body).rows.find((r) => r.id === id)
    expect(row).toMatchObject({ name: 'Дарья', lastSide: 'profi' })
    const v = ConvView.parse((await get(`/api/conversations/${id}`)).body)
    expect(v.messages.map((m) => m.side)).toEqual(['us', 'profi'])
    expect(v.chatUrl).toBe('https://profi.ru/backoffice/r.php?id=88690561')
  })

  it('FR-SET-5: Claude is well when the roles answered in the last hours, even with no probe today', async () => {
    await db.insert(modelCall).values({
      id: newEventId(),
      role: 'scorer',
      roleVersion: 1,
      model: 'haiku',
      priority: 'P1',
      startedAt: minutesAgo(5),
      durationMs: 900,
      ok: true,
    })
    const v = SystemView.parse((await get('/api/system')).body)
    expect(v.parts.find((p) => p.id === 'claude')).toMatchObject({ tone: 'ok', fix: null })
  })

  it('FR-LEAD-7: the bid text is edited from the pult only while the decision is open', async () => {
    expect((await post(`/api/leads/${LEAD}/text`, {})).status).toBe(400)
    const r = await post(`/api/leads/${LEAD}/text`, { text: 'Новый текст', priceRub: 50000 })
    expect(r).toEqual({ status: 200, body: { message: 'Записала.' } })
    expect(edits).toEqual([
      { taskId: LEAD_TASK, text: 'Новый текст', priceRub: 50000, followUps: null },
    ])
    // The series after the bid alone is an edit too (Boris, 29.10.2026).
    expect((await post(`/api/leads/${LEAD}/text`, { followUps: ['Из недавнего)'] })).status).toBe(
      200,
    )
    expect(edits.at(-1)).toEqual({
      taskId: LEAD_TASK,
      text: null,
      priceRub: null,
      followUps: ['Из недавнего)'],
    })
    await db.update(task).set({ state: 'resolved', resolution: 'skip' })
    expect((await post(`/api/leads/${LEAD}/text`, { text: 'Ещё' })).status).toBe(409)
    expect(edits).toHaveLength(2)
  })
})
