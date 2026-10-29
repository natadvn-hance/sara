import { newEventId, SettingsView } from '@sara/shared'
import { and, desc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { account, directionVersion, lead, leadLabel, leadScore, setting } from '../../src/db/schema'
import { activeRules, seedDirection } from '../../src/direction/store'
import { THRESHOLD_TEXTS } from '../../src/pult/threshold'
import { getSetting } from '../../src/settings/store'
import { buildTestApp, type TestApp } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
let t: TestApp

beforeEach(async () => {
  await resetDb(db)
  t = await buildTestApp(db)
  await t.app.inject({
    method: 'POST',
    url: '/api/setup/password',
    payload: { password: 'длинныйпароль1' },
  })
  await db.insert(account).values({ id: ACC, title: 'Hance маркетинг', egressIp: '127.0.0.1' })
  await seedDirection(db, ACC)
})
afterEach(() => t.close())

const get = async (url: string) => {
  const r = await t.app.inject({ method: 'GET', url, headers: { cookie: t.cookie() } })
  return { status: r.statusCode, body: r.json() as Record<string, unknown> }
}
const post = async (url: string, payload: object = {}) => {
  const r = await t.app.inject({ method: 'POST', url, payload, headers: { cookie: t.cookie() } })
  return { status: r.statusCode, body: r.json() as { message?: string; error?: string } }
}

describe('the switches of «Настройки» (pult v2 design 8)', () => {
  it('FR-OPS-1: a pause and the outgoing turn off at once and on only with the second press; the autopilot never on from here', async () => {
    await db.insert(setting).values({ key: 'outbound.bids', value: true, changedBy: 'system' })
    expect((await post('/api/settings/outbound.bids', { value: false })).status).toBe(200)
    expect(await getSetting(db, 'outbound.bids')).toBe(false)
    expect((await post('/api/settings/outbound.bids', { value: true })).status).toBe(403)
    expect((await post('/api/settings/outbound.bids', { value: true, confirm: true })).status).toBe(
      200,
    )
    expect(await getSetting(db, 'outbound.bids')).toBe(true)
    expect(
      (await post('/api/settings/outbound.messages', { value: true, confirm: true })).status,
    ).toBe(200)
    expect(
      (await post('/api/settings/conv.reminders', { value: true, confirm: true })).status,
    ).toBe(200)
    expect(
      (await post('/api/settings/conv.autopilot', { value: true, confirm: true })).status,
    ).toBe(403)
    expect(
      (await post('/api/settings/pipeline.leads', { value: true, confirm: true })).status,
    ).toBe(403)
    expect(
      (await post('/api/settings/conv.v1_writes', { value: false, confirm: true })).status,
    ).toBe(403)
    const v = SettingsView.parse((await get('/api/settings')).body)
    expect(v.groups.flatMap((g) => g.rows).find((r) => r.key === 'outbound.bids')).toMatchObject({
      edit: 'confirm',
      value: true,
      changedBy: 'boris',
    })
  })

  it('FR-NOTIF-2: the quiet hours, the clients’ night and the push kinds change from the settings', async () => {
    expect(
      (await post('/api/settings/cards.quiet_hours', { value: { from: 22, to: 8 } })).status,
    ).toBe(200)
    expect(await getSetting(db, 'cards.quiet_hours')).toEqual({ from: 22, to: 8 })
    expect((await post('/api/settings/conv.night', { value: { from: 22, to: 9 } })).status).toBe(
      200,
    )
    expect(
      (await post('/api/settings/cards.quiet_hours', { value: { from: 25, to: 8 } })).status,
    ).toBe(400)
    const push = {
      lead: true,
      draft: true,
      client: true,
      meeting: false,
      urgent: true,
      summary: false,
      system: false,
    }
    expect((await post('/api/settings/notify.push', { value: push })).status).toBe(200)
    expect(await getSetting(db, 'notify.push')).toEqual(push)
    expect((await post('/api/settings/notify.push', { value: { nonsense: true } })).status).toBe(
      400,
    )
    const v = SettingsView.parse((await get('/api/settings')).body)
    const notify = v.groups.find((g) => g.id === 'cards')?.rows.map((r) => r.key)
    expect(notify).toContain('notify.push')
  })
})

describe('the pult\u2019s own choices in the settings (Boris\u2019s open questions, the proposals kept changeable)', () => {
  it('FR-UI-4: the four tabs are a setting the frame reads; a section stands in one place only', async () => {
    expect((await get('/api/prefs')).body).toEqual({ tabs: ['inbox', 'leads', 'clients', 'today'] })
    const tabs = ['inbox', 'clients', 'leads', 'meetings']
    expect((await post('/api/settings/pult.tabs', { value: tabs })).status).toBe(200)
    expect((await get('/api/prefs')).body).toEqual({ tabs })
    expect(
      (await post('/api/settings/pult.tabs', { value: ['inbox', 'inbox', 'leads', 'today'] }))
        .status,
    ).toBe(400)
    expect(
      (await post('/api/settings/pult.tabs', { value: ['inbox', 'leads', 'today'] })).status,
    ).toBe(400)
    expect(
      (await post('/api/settings/pult.tabs', { value: ['inbox', 'leads', 'today', 'nonsense'] }))
        .status,
    ).toBe(400)
  })

  it('FR-OPS-1: with «Включать паузы и отправку из пульта» off, they only turn off from the pult', async () => {
    expect((await post('/api/settings/pult.switch_on', { value: false })).status).toBe(200)
    const r = await post('/api/settings/outbound.bids', { value: true, confirm: true })
    expect(r.status).toBe(403)
    expect(r.body.error).toContain('настройках «Пульт»')
    expect((await post('/api/settings/outbound.bids', { value: false })).status).toBe(200)
    const v = SettingsView.parse((await get('/api/settings')).body)
    expect(v.groups.flatMap((g) => g.rows).find((x) => x.key === 'outbound.bids')?.edit).toBe(
      'stop_only',
    )
    expect(v.groups[0]?.rows.map((x) => x.key)).toEqual(['pult.tabs', 'pult.switch_on'])
    // Turning the choice back on takes the second press too.
    expect((await post('/api/settings/pult.switch_on', { value: true })).status).toBe(403)
    expect(
      (await post('/api/settings/pult.switch_on', { value: true, confirm: true })).status,
    ).toBe(200)
    expect((await post('/api/settings/outbound.bids', { value: true, confirm: true })).status).toBe(
      200,
    )
  })
})

describe('«Минимальный балл»: a hint from the stored scores, then a new version of the rules', () => {
  async function scored(id: string, score: number, label: 'yes' | 'no' | null) {
    await db.insert(lead).values({
      id,
      accountId: ACC,
      title: `Заявка ${id}`,
      category: 'Маркетинг',
      city: 'Краснодар',
      text: 'Нужна помощь.',
      clientName: 'Ирина',
      bidPriceRub: 200,
      seenAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      status: 'queued',
      correlationId: newEventId(),
    })
    await db.insert(leadScore).values({
      id: newEventId(),
      leadId: id,
      version: 1,
      score,
      decision: 'card',
      stopFactor: null,
      redFlags: [],
      axes: [],
      reason: 'r',
      confidence: 0.8,
      model: 'haiku',
    })
    if (label) await db.insert(leadLabel).values({ leadId: id, label, source: 'card' })
  }

  it('FR-OPS-1, ST-M7-07: the hint counts the last week: cards then and now, «да» lost and «нет» gained', async () => {
    const { rules, version } = await activeRules(db, ACC)
    const cur = rules.threshold
    await scored('97000001', cur + 10, 'yes')
    await scored('97000002', cur + 1, 'yes')
    await scored('97000003', cur - 1, 'no')
    await scored('97000004', cur - 10, null)
    const up = (await get(`/api/settings/threshold/${ACC}?value=${cur + 2}`)).body
    expect(up).toEqual({
      value: cur + 2,
      current: cur,
      version,
      cardsNow: 2,
      cardsWould: 1,
      lostYes: 1,
      gainedNo: 0,
    })
    const down = (await get(`/api/settings/threshold/${ACC}?value=${cur - 2}`)).body
    expect(down).toMatchObject({ cardsNow: 2, cardsWould: 3, lostYes: 0, gainedNo: 1 })
    expect((await get(`/api/settings/threshold/${ACC}?value=101`)).status).toBe(400)
  })

  it('FR-ACC-2, ST-M7-07: «Сохранить» makes a new active version from the one Boris saw, the old one stays', async () => {
    const { rules, version } = await activeRules(db, ACC)
    const to = rules.threshold + 3
    expect(
      (await post(`/api/settings/threshold/${ACC}`, { value: to, expectedVersion: version + 5 }))
        .body,
    ).toEqual({
      error: THRESHOLD_TEXTS.stale,
    })
    const ok = await post(`/api/settings/threshold/${ACC}`, { value: to, expectedVersion: version })
    expect(ok.body.message).toBe(THRESHOLD_TEXTS.saved(rules.threshold, to, version + 1))
    const now = await activeRules(db, ACC)
    expect(now.version).toBe(version + 1)
    expect(now.rules).toEqual({ ...rules, threshold: to })
    const [row] = await db
      .select()
      .from(directionVersion)
      .where(and(eq(directionVersion.accountId, ACC), eq(directionVersion.active, true)))
      .orderBy(desc(directionVersion.version))
    expect(row).toMatchObject({
      createdBy: 'boris',
      reason: `Порог ${rules.threshold} → ${to} из настроек`,
    })
    expect(
      (await post(`/api/settings/threshold/${ACC}`, { value: to, expectedVersion: version + 1 }))
        .body,
    ).toEqual({
      error: THRESHOLD_TEXTS.same,
    })
  })
})
