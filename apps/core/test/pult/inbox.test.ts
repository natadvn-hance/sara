import {
  InboxView,
  JournalView,
  type NoticeKind,
  NoticeList,
  newEventId,
  SearchView,
  TraceView,
} from '@sara/shared'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../src/db/client'
import {
  account,
  chatMessage,
  conversation,
  convTurn,
  lead,
  notice,
  question,
  ruleProposal,
  task,
} from '../../src/db/schema'
import { subscribe } from '../../src/journal/bus'
import { appendEvent } from '../../src/journal/journal'
import {
  classifyNotice,
  noticeList,
  recordNotice,
  taskOfRows,
  withNoticeLog,
} from '../../src/notify/center'
import type { Notifier } from '../../src/notify/notifier'
import { createResolver, type Press } from '../../src/tasks/resolve'
import { buildTestApp, type TestApp } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const LEAD = '95000011'
const LEAD_TASK = '11111111-1111-4111-8111-111111111121'
const CONV = '22222222-2222-4222-8222-222222222221'
const DRAFT_TASK = '33333333-3333-4333-8333-333333333321'
const REMINDER_TASK = '33333333-3333-4333-8333-333333333322'
const PROPOSAL = '44444444-4444-4444-8444-444444444421'
const PROPOSAL_TASK = '44444444-4444-4444-8444-444444444422'
const WHY = '55555555-5555-4555-8555-555555555521'
const EDIT = '55555555-5555-4555-8555-555555555522'

let t: TestApp
let presses: Press[] = []
let answers: { kind: string; text: string }[] = []

/** Made-up data only: a lead to decide, a draft and a reminder to a client, a rule proposal, two questions. */
async function seed(d: Db) {
  const now = Date.now()
  const ago = (min: number) => new Date(now - min * 60_000).toISOString()
  await d.insert(account).values({
    id: 'hance-marketing',
    title: 'Hance маркетинг',
    egressIp: '127.0.0.1',
    loginState: 'alive',
    balanceRub: 1200,
  })
  await d.insert(lead).values({
    id: LEAD,
    accountId: 'hance-marketing',
    title: 'Сайт для стоматологии',
    category: 'Маркетинг',
    city: 'Краснодар',
    text: 'Нужен сайт и поток записей.',
    clientName: 'Анна',
    budgetText: 'до 80 000 ₽',
    bidPriceRub: 210,
    seenAt: ago(25),
    status: 'queued',
    correlationId: newEventId(),
    draftText: 'Анна, добрый день! ...',
    draftPriceRub: 50000,
  })
  await d.insert(task).values({
    id: LEAD_TASK,
    kind: 'lead_decision',
    entityKind: 'lead',
    entityId: LEAD,
    createdAt: ago(25),
  })
  await d.insert(conversation).values({
    id: CONV,
    accountId: 'hance-marketing',
    chatId: 'chat-11',
    orderId: LEAD,
    origin: 'sara',
  })
  await d.insert(chatMessage).values({
    id: newEventId(),
    accountId: 'hance-marketing',
    chatId: 'chat-11',
    orderId: LEAD,
    platformMessageId: 'm11',
    side: 'client',
    author: 'client',
    authorBasis: 'side',
    text: 'Можете позвонить?',
    sentAt: ago(3),
    source: 'live',
    conversationId: CONV,
  })
  await d.insert(convTurn).values({
    id: 'turn-11',
    conversationId: CONV,
    anchorMessageId: 'm11',
    messageIds: ['m11'],
    text: 'Анна, добрый день! Да, давайте созвонимся.',
    urgent: true,
    state: 'carded',
  })
  await d.insert(task).values({
    id: DRAFT_TASK,
    kind: 'conv_draft',
    entityKind: 'conv_turn',
    entityId: 'turn-11',
    createdAt: ago(2),
  })
  await d.insert(convTurn).values({
    id: 'turn-12',
    conversationId: CONV,
    kind: 'reminder',
    anchorMessageId: 'm11',
    text: 'Анна, напомню о себе.',
    state: 'carded',
    outcome: 'carded',
  })
  await d.insert(task).values({
    id: REMINDER_TASK,
    kind: 'conv_draft',
    entityKind: 'conv_turn',
    entityId: 'turn-12',
    createdAt: ago(1),
  })
  await d.insert(ruleProposal).values({
    id: PROPOSAL,
    accountId: 'hance-marketing',
    fromVersion: 3,
    rules: {},
    summary: 'стоп-фактор для SMM без стратегии',
    why: 'ты пропустил пять таких',
    backtest: { checked: 40, changed: 3, towardBoris: 3, against: 0 },
    state: 'open',
    taskId: PROPOSAL_TASK,
  })
  await d.insert(task).values({
    id: PROPOSAL_TASK,
    kind: 'rule_proposal',
    entityKind: 'rule_proposal',
    entityId: PROPOSAL,
    createdAt: ago(60),
  })
  await d
    .insert(question)
    .values({ id: WHY, kind: 'why_skip', entityId: LEAD, askedAt: ago(40), telegramMessageId: 501 })
  await d.insert(question).values({
    id: EDIT,
    kind: 'edit_price',
    entityId: LEAD_TASK,
    askedAt: ago(30),
    telegramMessageId: 502,
  })
}

beforeEach(async () => {
  await resetDb(db)
  presses = []
  answers = []
  t = await buildTestApp(db, {}, undefined, {
    onPress: async (p) => {
      presses.push(p)
      return 'Принято.'
    },
    answerQuestion: async (q, text) => {
      answers.push({ kind: q.kind, text })
      return 'Записала.'
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
  return { status: r.statusCode, body: r.json() as unknown }
}
const post = async (url: string, payload: object = {}) => {
  const r = await t.app.inject({ method: 'POST', url, payload, headers: { cookie: t.cookie() } })
  return { status: r.statusCode, body: r.json() as { message?: string; error?: string } }
}

describe('«Входящие»: everything that waits for Boris, decided on the spot', () => {
  it('FR-UI-6: tasks and questions become rows with their presses, the urgent first, the oldest next', async () => {
    const v = InboxView.parse((await get('/api/inbox')).body)
    expect(v.items.map((i) => i.id)).toEqual([
      `task:${DRAFT_TASK}`,
      `task:${PROPOSAL_TASK}`,
      `question:${WHY}`,
      `question:${EDIT}`,
      `task:${LEAD_TASK}`,
      `task:${REMINDER_TASK}`,
    ])
    const draft = v.items[0]
    expect(draft).toMatchObject({
      kind: 'conv_draft',
      urgent: true,
      title: 'Черновик ответа клиенту',
      sub: 'Анна: «Можете позвонить?»',
      text: 'Анна, добрый день! Да, давайте созвонимся.',
      entity: { kind: 'client', id: CONV, title: 'Анна' },
      link: `/clients/${CONV}`,
    })
    expect(draft?.actions.map((a) => [a.id, a.path])).toEqual([
      ['send', `/api/tasks/${DRAFT_TASK}/send`],
      ['take', `/api/tasks/${DRAFT_TASK}/take`],
      ['close', `/api/tasks/${DRAFT_TASK}/close`],
    ])
    const leadRow = v.items.find((i) => i.id === `task:${LEAD_TASK}`)
    expect(leadRow).toMatchObject({
      kind: 'lead_decision',
      feeRub: 210,
      sub: 'Краснодар · отклик 210 ₽ · бюджет до 80 000 ₽',
      entity: { kind: 'lead', id: LEAD, title: 'Сайт для стоматологии' },
    })
    expect(leadRow?.actions.map((a) => [a.id, a.needs])).toEqual([
      ['bid', 'fee'],
      ['skip', 'reason'],
    ])
    expect(v.items.find((i) => i.id === `task:${REMINDER_TASK}`)).toMatchObject({
      kind: 'conv_reminder',
      actions: [expect.objectContaining({ id: 'send' }), expect.objectContaining({ id: 'skip' })],
    })
    expect(v.items.find((i) => i.id === `task:${PROPOSAL_TASK}`)?.sub).toContain(
      'v3 → v4: стоп-фактор для SMM без стратегии. ты пропустил пять таких На последних 40 заявках изменило бы 3: 3 в твою сторону, 0 против.',
    )
    expect(v.items.find((i) => i.id === `question:${EDIT}`)).toMatchObject({
      title: 'Жду стоимость услуги',
      entity: { kind: 'lead', id: LEAD },
      actions: [
        expect.objectContaining({
          id: 'answer',
          needs: 'text',
          path: `/api/questions/${EDIT}/answer`,
        }),
        expect.objectContaining({ id: 'skip', path: `/api/questions/${EDIT}/skip` }),
      ],
    })
    expect(v.counts).toEqual({ leads: 2, drafts: 2, questions: 2, other: 0 })
  })

  it('FR-UI-6: a kind the pult does not know shows a row without presses and breaks nothing', async () => {
    await db.insert(task).values({
      id: newEventId(),
      kind: 'lesson_batch',
      entityKind: 'lesson_batch',
      entityId: 'b1',
    })
    const v = InboxView.parse((await get('/api/inbox')).body)
    const row = v.items.find((i) => i.kind === 'lesson_batch')
    expect(row).toMatchObject({ title: 'Задача: lesson_batch', actions: [], link: null })
    expect(v.counts.other).toBe(1)
  })

  it('FR-UI-6: a skip from the pult carries the reason to the press; a question is answered or put aside', async () => {
    expect((await post(`/api/tasks/${LEAD_TASK}/skip`, { reason: 'не наш профиль' })).status).toBe(
      200,
    )
    expect(presses).toEqual([
      { taskId: LEAD_TASK, action: 'skip', source: 'pult', reason: 'не наш профиль' },
    ])
    expect((await post(`/api/tasks/${PROPOSAL_TASK}/apply`)).status).toBe(200)
    expect(presses[1]).toMatchObject({ taskId: PROPOSAL_TASK, action: 'apply', source: 'pult' })
    expect((await post(`/api/questions/${WHY}/answer`, { text: 'дорого' })).body).toEqual({
      message: 'Записала.',
    })
    expect(answers).toEqual([{ kind: 'why_skip', text: 'дорого' }])
    expect((await post(`/api/questions/${WHY}/answer`, {})).status).toBe(400)
    expect((await post(`/api/questions/${EDIT}/skip`)).body).toEqual({
      message: 'Хорошо, не важно.',
    })
    expect((await post(`/api/questions/${EDIT}/skip`)).status).toBe(409)
    const v = InboxView.parse((await get('/api/inbox')).body)
    expect(v.items.some((i) => i.id === `question:${EDIT}`)).toBe(false)
  })
})

describe('the resolver: one press from anywhere, the Telegram card marked when it came from the pult', () => {
  const marked: { id: number; note: string }[] = []
  const resolver = (pressed: (p: Press) => Promise<string>) =>
    createResolver({
      db,
      press: pressed,
      notifier: {
        markDone: async (id, note) => {
          marked.push({ id, note })
        },
      },
    })

  it('FR-UI-6, ST-M7-03: the press from the pult that closes the task marks its card «Решено в приложении»', async () => {
    marked.length = 0
    await db.update(task).set({ telegramMessageId: 777 }).where(sql`${task.id} = ${LEAD_TASK}`)
    const resolve = resolver(async (p) => {
      await db
        .update(task)
        .set({ state: 'resolved', resolution: p.action, resolvedAt: new Date().toISOString() })
        .where(sql`${task.id} = ${p.taskId}`)
      return 'Пропущено'
    })
    expect(await resolve({ taskId: LEAD_TASK, action: 'skip', source: 'pult' })).toBe('Пропущено')
    expect(marked).toEqual([{ id: 777, note: 'Решено в приложении: пропущено' }])
  })

  it('FR-UI-6: a press from Telegram, or one that leaves the task open, marks nothing', async () => {
    marked.length = 0
    await db.update(task).set({ telegramMessageId: 778 }).where(sql`${task.id} = ${LEAD_TASK}`)
    const noop = resolver(async () => 'Отправка откликов на паузе')
    expect(await noop({ taskId: LEAD_TASK, action: 'bid', source: 'pult' })).toBe(
      'Отправка откликов на паузе',
    )
    const closing = resolver(async (p) => {
      await db
        .update(task)
        .set({ state: 'resolved', resolution: p.action })
        .where(sql`${task.id} = ${p.taskId}`)
      return 'ок'
    })
    await closing({ taskId: LEAD_TASK, action: 'skip' })
    expect(marked).toEqual([])
  })
})

describe('the bell: every message of Sara with its state', () => {
  const fakeNotifier = (): Notifier & { sent: string[] } => {
    const sent: string[] = []
    let next = 900
    return {
      sent,
      sendLeadCard: async () => ({ messageId: next++ }),
      closeLeadCard: async () => {},
      sendText: async (text) => {
        sent.push(text)
        return { messageId: next++ }
      },
      sendButtons: async (text) => {
        sent.push(text)
        return { messageId: next++ }
      },
    }
  }

  it('FR-NOTIF-1: the kind is read off the head of the text or taken from the hint; the task from the buttons', () => {
    const cases: [string, NoticeKind][] = [
      ['🚨 Клиент просит позвонить', 'urgent'],
      ['🔴 Профи.ру разлогинил аккаунт', 'urgent'],
      ['📅 Встреча назначена', 'meeting'],
      ['💬 Анна: новое сообщение', 'client'],
      ['Сегодня отсеяла 12 заявок. На грани:', 'summary'],
      ['Записала новый текст', 'system'],
    ]
    for (const [text, kind] of cases) expect(classifyNotice(text), text).toBe(kind)
    expect(taskOfRows([[{ callbackData: `t:${LEAD_TASK}:bid` }]])).toBe(LEAD_TASK)
    expect(taskOfRows([[{ callbackData: 'done' }]])).toBeNull()
  })

  it('FR-NOTIF-1: a lead card, a draft card and a plain alarm each leave one notice; the same card twice in an hour is one', async () => {
    const n = withNoticeLog(fakeNotifier(), db)
    await n.sendLeadCard({
      taskId: LEAD_TASK,
      orderId: LEAD,
      title: 'Сайт для стоматологии',
      city: 'Краснодар',
      budgetText: 'до 80 000 ₽',
      clientName: 'Анна',
      text: 'Нужен сайт.',
      clientInfo: null,
      verdict: 'fit',
      reason: null,
      bidPriceRub: 210,
      score: { value: 72, version: 1, reason: 'наш профиль' },
      unscored: false,
      draft: null,
      analysis: null,
    })
    await n.sendButtons('💬 Анна, заказ «Сайт для стоматологии»\nМожете позвонить?', [
      [{ text: 'Отправить', callbackData: `t:${DRAFT_TASK}:send` }],
    ])
    await n.sendText('🚨 Клиент просит позвонить: Анна', { loud: true })
    await n.sendText('Почему пропустил «Сайт»?', {
      notice: { kind: 'lead', questionId: WHY, link: `/leads/${LEAD}` },
    })
    expect(
      await recordNotice(db, {
        kind: 'lead',
        title: 'Заявка: Сайт для стоматологии',
        body: '',
        link: null,
        taskId: LEAD_TASK,
      }),
    ).toBeNull()
    const list = await noticeList(db)
    expect(list.items.map((i) => [i.kind, i.title, i.state])).toEqual([
      ['lead', 'Почему пропустил «Сайт»?', 'new'],
      ['urgent', 'Клиент просит позвонить: Анна', 'new'],
      ['draft', 'Анна, заказ «Сайт для стоматологии»', 'new'],
      ['lead', 'Заявка: Сайт для стоматологии', 'new'],
    ])
    expect(list.items[3]).toMatchObject({
      body: 'Краснодар · балл 72 · отклик 210 ₽ · бюджет до 80 000 ₽',
      link: `/leads/${LEAD}`,
      taskId: LEAD_TASK,
    })
    expect(list.items[2]).toMatchObject({ taskId: DRAFT_TASK, body: 'Можете позвонить?' })
    expect(list.items[0]).toMatchObject({ questionId: WHY, link: `/leads/${LEAD}` })
    expect(list.unseen).toBe(4)
  })

  it('FR-NOTIF-1: seen when looked at, done when the task or question closed anywhere, put away by hand', async () => {
    await db.insert(notice).values([
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        kind: 'lead',
        title: 'Заявка',
        body: '',
        taskId: LEAD_TASK,
      },
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        kind: 'lead',
        title: 'Почему?',
        body: '',
        questionId: WHY,
      },
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000003',
        kind: 'system',
        title: 'Связь вернулась',
        body: '',
      },
    ])
    expect(
      (await post('/api/notices/seen', { ids: ['aaaaaaaa-0000-4000-8000-000000000001'] })).status,
    ).toBe(200)
    await db
      .update(task)
      .set({ state: 'resolved', resolution: 'skip', resolvedAt: new Date().toISOString() })
      .where(sql`${task.id} = ${LEAD_TASK}`)
    await db
      .update(question)
      .set({ answeredAt: new Date().toISOString(), answer: 'дорого' })
      .where(sql`${question.id} = ${WHY}`)
    expect((await post('/api/notices/aaaaaaaa-0000-4000-8000-000000000003/done')).status).toBe(200)
    expect((await post('/api/notices/aaaaaaaa-0000-4000-8000-000000000003/done')).status).toBe(404)
    const all = NoticeList.parse((await get('/api/notices')).body)
    expect(all.items.map((i) => i.state)).toEqual(['done', 'done', 'done'])
    expect(all.unseen).toBe(0)
    const open = NoticeList.parse((await get('/api/notices?state=open')).body)
    expect(open.items).toEqual([])
  })
})

describe('the journal, the trace and the search', () => {
  it('FR-OPS-4: events page by type in the words of the feed where it knows them; the trace follows one chain', async () => {
    const corr = newEventId()
    const callId = newEventId()
    await db.execute(sql`insert into core.model_call (id, role, role_version, model, priority, started_at, duration_ms, ok)
      values (${callId}, 'scorer', 1, 'haiku', 'P1', now(), 3200, true)`)
    const base = {
      v: 1,
      account_id: 'hance-marketing',
      actor: 'sara' as const,
      causation_id: null,
      correlation_id: corr,
      reason: null,
    }
    await appendEvent(db, {
      ...base,
      type: 'lead.found',
      entity: { kind: 'lead', id: LEAD },
      occurred_at: new Date(Date.now() - 60_000).toISOString(),
      payload: {},
    })
    await appendEvent(db, {
      ...base,
      type: 'model.called',
      entity: { kind: 'model_call', id: callId },
      occurred_at: new Date(Date.now() - 50_000).toISOString(),
      payload: { role: 'scorer' },
    })
    await appendEvent(db, {
      ...base,
      type: 'lead.scored',
      entity: { kind: 'lead', id: LEAD },
      occurred_at: new Date(Date.now() - 40_000).toISOString(),
      payload: { score: 72 },
    })
    const j = JournalView.parse((await get('/api/journal?type=lead.scored')).body)
    expect(j.items).toHaveLength(1)
    expect(j.items[0]).toMatchObject({
      type: 'lead.scored',
      text: 'Оценила «Сайт для стоматологии»: балл 72',
      entity: { kind: 'lead', id: LEAD },
      correlationId: corr,
    })
    expect(j.types).toContain('lead.found')
    const tr = TraceView.parse((await get(`/api/journal/trace/${corr}`)).body)
    expect(tr.events.map((e) => e.type)).toEqual(['lead.found', 'model.called', 'lead.scored'])
    expect(tr.entity).toEqual({ kind: 'lead', id: LEAD, title: 'Сайт для стоматологии' })
    expect(tr.calls).toEqual([
      expect.objectContaining({ id: callId, role: 'scorer', model: 'haiku', ok: true, ms: 3200 }),
    ])
    expect((await get('/api/journal/trace/not-a-uuid')).status).toBe(404)
  })

  it('FR-UI-2: the order number finds the lead first; a client by name, a record of the mind by title', async () => {
    await db.execute(sql`insert into core.mind_index (record_id, path, type, scope, title, body, version, mind_version, tsv)
      values ('K-001', 'mind/knowledge/price.md', 'knowledge', 'common', 'Как говорим о цене', 'Цену называем вилкой.', 2, 'abc123', to_tsvector('russian', 'Цену называем вилкой'))`)
    const byNumber = SearchView.parse((await get(`/api/search?q=${LEAD}`)).body)
    expect(byNumber.hits[0]).toMatchObject({ kind: 'lead', id: LEAD, link: `/leads/${LEAD}` })
    const byName = SearchView.parse((await get('/api/search?q=анна')).body)
    expect(byName.hits.map((h) => h.kind)).toEqual(['lead', 'client'])
    expect(byName.hits[1]).toMatchObject({ id: CONV, title: 'Анна', link: `/clients/${CONV}` })
    const byTitle = SearchView.parse((await get('/api/search?q=цене')).body)
    expect(byTitle.hits).toEqual([
      expect.objectContaining({ kind: 'mind', id: 'K-001', link: '/mind/K-001' }),
    ])
    expect(SearchView.parse((await get('/api/search?q=a')).body).hits).toEqual([])
  })
})

describe('the live stream', () => {
  it('FR-UI-2, ST-M7-15: every event the journal writes is told on the bus with its type, kind and id only', async () => {
    const seen: unknown[] = []
    const off = subscribe((e) => seen.push(e))
    await appendEvent(db, {
      type: 'lead.found',
      v: 1,
      entity: { kind: 'lead', id: LEAD },
      account_id: 'hance-marketing',
      actor: 'sara',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: newEventId(),
      reason: null,
      payload: { title: 'не для потока' },
    })
    await new Promise((r) => setImmediate(r))
    off()
    expect(seen).toEqual([{ type: 'lead.found', kind: 'lead', id: LEAD, at: expect.any(String) }])
  })

  it('FR-UI-2: GET /api/stream answers as server-sent events behind the owner session and carries the next event', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/stream' })).statusCode).toBe(401)
    const url = await t.app.listen({ port: 0, host: '127.0.0.1' })
    const ctrl = new AbortController()
    const res = await fetch(`${url}/api/stream`, {
      headers: { cookie: t.cookie() },
      signal: ctrl.signal,
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    const read = async () => new TextDecoder().decode((await reader.read()).value)
    expect(await read()).toContain(': ready')
    await appendEvent(db, {
      type: 'task.resolved',
      v: 1,
      entity: { kind: 'task', id: LEAD_TASK },
      account_id: null,
      actor: 'boris',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: newEventId(),
      reason: null,
      payload: { action: 'skip' },
    })
    const line = await read()
    expect(line).toContain('"type":"task.resolved"')
    expect(line).not.toContain('skip')
    ctrl.abort()
  })
})
