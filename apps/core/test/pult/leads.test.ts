import { combinedScore, InboxView, LeadQueue, LeadView, newEventId } from '@sara/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../src/db/client'
import { account, bidHold, lead, leadLabel, leadScore, task } from '../../src/db/schema'
import type { Press } from '../../src/tasks/resolve'
import { buildTestApp, type TestApp } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const A = '95000051'
const B = '95000052'
const C = '95000053'
const TA = '88888888-8888-4888-8888-888888888851'
const TB = '88888888-8888-4888-8888-888888888852'
const TC = '88888888-8888-4888-8888-888888888853'

let t: TestApp
let presses: Press[] = []
let holds: { leadId: string; fee: number }[] = []
let cancels: string[] = []
let rechecks: string[] = []

async function seed(d: Db) {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
  await d
    .insert(account)
    .values({ id: 'hance-marketing', title: 'Hance маркетинг', egressIp: '127.0.0.1' })
  const mk = (id: string, title: string, fee: number, min: number) =>
    d.insert(lead).values({
      id,
      accountId: 'hance-marketing',
      title,
      category: 'Маркетинг',
      city: 'Краснодар',
      text: 'Нужна помощь.',
      clientName: 'Ирина',
      bidPriceRub: fee,
      seenAt: ago(min),
      status: 'queued',
      correlationId: newEventId(),
      draftText: 'Ирина, добрый день! ...',
      draftPriceRub: 30000,
    })
  await mk(A, 'Стратегия для пекарни', 210, 30)
  await mk(B, 'Сайт для студии', 150, 20)
  await mk(C, 'Реклама для кофейни', 300, 10)
  const score = (leadId: string, value: number) =>
    d.insert(leadScore).values({
      id: newEventId(),
      leadId,
      version: 1,
      score: value,
      decision: 'card',
      stopFactor: null,
      redFlags: [],
      axes: [{ id: 'fit', score: value, why: 'наш профиль' }],
      reason: `балл ${value}`,
      confidence: 0.7,
      model: 'haiku',
    })
  await score(A, 72)
  await score(B, 88)
  await score(C, 60)
  await d.insert(task).values([
    { id: TA, kind: 'lead_decision', entityKind: 'lead', entityId: A },
    { id: TB, kind: 'lead_decision', entityKind: 'lead', entityId: B },
    { id: TC, kind: 'lead_decision', entityKind: 'lead', entityId: C },
  ])
}

beforeEach(async () => {
  await resetDb(db)
  presses = []
  holds = []
  cancels = []
  rechecks = []
  t = await buildTestApp(db, {}, undefined, {
    onPress: async (p) => {
      presses.push(p)
      return 'Заявка закрыта'
    },
    bids: {
      hold: async (leadId, fee) => {
        holds.push({ leadId, fee })
        return {
          ok: true,
          message: 'Откликаюсь через 10 секунд.',
          executeAt: new Date(Date.now() + 10_000).toISOString(),
        }
      },
      cancel: async (leadId) => {
        cancels.push(leadId)
        return { ok: true, message: 'Отменила, отклик не ушёл.' }
      },
      recheck: async (leadId) => {
        rechecks.push(leadId)
        return { message: 'Перечитала заказ: он открыт.', closed: false }
      },
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

describe('the score as two numbers (Boris, 29.10.2026)', () => {
  it('FR-LEAD-10: the two together make the order; with the chance unknown the fit alone', () => {
    expect(combinedScore(80, null)).toBe(80)
    expect(combinedScore(null, 70)).toBe(70)
    expect(combinedScore(null, null)).toBeNull()
    expect(combinedScore(90, 40)).toBe(60)
    // Strong in one and weak in the other does not rise above good in both.
    expect(combinedScore(95, 20)).toBeLessThan(combinedScore(70, 70) ?? 0)
  })

  it('FR-LEAD-10, FR-UI-5: the queue carries «насколько наше» and «шанс» (считается), ordered by the two together or by one', async () => {
    const q = LeadQueue.parse((await get('/api/leads')).body)
    expect(q.queue.map((r) => r.id)).toEqual([B, A, C])
    expect(q.queue[0]?.scores).toEqual({
      fit: { value: 88, reasons: ['балл 88', 'наш профиль'] },
      chance: { value: null, reasons: [] },
      combined: 88,
    })
    expect(
      LeadQueue.parse((await get('/api/leads?order=fit')).body).queue.map((r) => r.id),
    ).toEqual([B, A, C])
    // No chance is known yet: by the chance the cheaper bid goes first.
    expect(
      LeadQueue.parse((await get('/api/leads?order=chance')).body).queue.map((r) => r.id),
    ).toEqual([B, A, C])
    expect((await get('/api/leads?order=nonsense')).status).toBe(400)
  })

  it('FR-UI-5: a lead shows both numbers with their reasons and the confidence', async () => {
    const v = LeadView.parse((await get(`/api/leads/${A}`)).body)
    expect(v.score?.scores?.fit.value).toBe(72)
    expect(v.score?.scores?.chance.value).toBeNull()
    expect(v.score?.confidence).toBeCloseTo(0.7)
    expect(v.hold).toBeNull()
  })
})

describe('the lead presses of the pult', () => {
  it('ST-M7-04: «Откликнуться» from the pult is held, by the lead and by its task alike; «Отменить» goes to the hold', async () => {
    expect((await post(`/api/leads/${A}/bid`, { expectedFeeRub: 210 })).status).toBe(200)
    expect((await post(`/api/tasks/${TA}/bid`, { expectedFeeRub: 210 })).status).toBe(200)
    expect(holds).toEqual([
      { leadId: A, fee: 210 },
      { leadId: A, fee: 210 },
    ])
    expect(presses).toEqual([])
    expect((await post(`/api/leads/${A}/bid`)).status).toBe(400)
    expect((await post(`/api/leads/${A}/bid/cancel`)).body).toEqual({
      message: 'Отменила, отклик не ушёл.',
    })
    expect(cancels).toEqual([A])
  })

  it('FR-LEAD-7: «Закрыть заявку» with a reason is the card press from the pult; a decided lead answers so', async () => {
    expect((await post(`/api/leads/${B}/skip`, { reason: 'дорого' })).body).toEqual({
      message: 'Заявка закрыта',
    })
    expect(presses).toEqual([{ taskId: TB, action: 'skip', source: 'pult', reason: 'дорого' }])
    await db.update(task).set({ state: 'resolved', resolution: 'skip' })
    expect((await post(`/api/leads/${B}/skip`)).status).toBe(409)
  })

  it('FR-LEAD-5: «Перепроверить» reads the order now', async () => {
    expect((await post(`/api/leads/${C}/recheck`)).body).toEqual({
      message: 'Перечитала заказ: он открыт.',
      closed: false,
    })
    expect(rechecks).toEqual([C])
  })

  it('FR-UI-6: in the Inbox a lead row bids and skips through the lead, shows the fit and its hold', async () => {
    await db.insert(bidHold).values({
      taskId: TC,
      requestId: newEventId(),
      state: 'held',
      expectedFeeRub: 300,
      executeAt: new Date(Date.now() + 8000).toISOString(),
    })
    const v = InboxView.parse((await get('/api/inbox')).body)
    const a = v.items.find((i) => i.id === `task:${TA}`)
    expect(a?.actions.map((x) => x.path)).toEqual([`/api/leads/${A}/bid`, `/api/leads/${A}/skip`])
    expect(a?.sub).toBe('Краснодар · наше 72 · отклик 210 ₽')
    expect(v.items.find((i) => i.id === `task:${TC}`)?.hold).toEqual({
      executeAt: expect.any(String),
    })
  })

  it('FR-LEAD-7: the decided list keeps a month with Boris’s reason of a skip', async () => {
    await db.update(task).set({
      state: 'resolved',
      resolution: 'skip',
      resolvedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    })
    await db
      .insert(leadLabel)
      .values({ leadId: A, label: 'no', source: 'pult', reason: 'не наш профиль' })
    const q = LeadQueue.parse((await get('/api/leads')).body)
    expect(q.queue).toEqual([])
    expect(q.decided.find((x) => x.id === A)).toMatchObject({
      decision: 'skip',
      reason: 'не наш профиль',
    })
    expect(q.decided).toHaveLength(3)
  })
})
