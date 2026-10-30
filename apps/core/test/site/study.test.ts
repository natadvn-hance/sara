import { type LeadSite, newEventId, type SiteBrief } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readSiteOfTurn } from '../../src/conversation/siteTurn'
import { event, lead, modelCall, siteCache } from '../../src/db/schema'
import { leadSiteOf, studyLeadSite } from '../../src/site/lead'
import { CACHE_FAILED_MS, CACHE_OK_MS } from '../../src/site/read'
import { BRIEFS_PER_DAY, siteCmsFor, studyClientSite, tidyBrief } from '../../src/site/study'
import { siteCardView, siteSection } from '../../src/site/view'
import { openTestDb, resetDb } from '../helpers/db'
import { type FakeGateway, fakeGateway } from '../helpers/gateway'
import { dentalSite, fakeSiteFetch, WP_HOME } from './fakeSite'

const { db, close } = openTestDb()
afterAll(close)

const ORDER_TEXT =
  'Нужно больше заявок для стоматологии. Мой сайт ulybka-plus.ru, пациенты почти не оставляют заявки.'
const ORDER = { title: 'Больше заявок для клиники', category: 'Маркетинг', text: ORDER_TEXT }
const BRIEF: SiteBrief = {
  business: 'Стоматологическая клиника в Краснодаре',
  audience: 'Семьи с детьми, судя по разделам про детскую стоматологию',
  offer: 'Лечение, имплантация, брекеты',
  seen: ['формы заявки нет, только телефон', 'цены открыты', 'в подвале 2018 год'],
  link: 'Заказ про заявки, а на сайте заявку можно оставить только звонком',
  hooks: ['заявку можно оставить только по телефону'],
  guesses: ['Похоже, сайт давно не обновляли'],
  summary: 'Стоматология в Краснодаре на Tilda, заявка только по телефону',
}
const NOW = new Date('2026-10-30T12:00:00Z')

let gw: FakeGateway
beforeEach(async () => {
  await resetDb(db)
  gw = await fakeGateway(db, { 'site-reader': BRIEF })
})

const seedLead = async (id = '1', text = ORDER_TEXT) => {
  const correlationId = newEventId()
  await db.insert(lead).values({
    id,
    accountId: 'hance-marketing',
    title: ORDER.title,
    category: ORDER.category,
    city: 'Краснодар',
    text,
    clientName: 'Ирина',
    bidPriceRub: 210,
    seenAt: NOW.toISOString(),
    correlationId,
  })
  return correlationId
}
const deps = (fetchPage: ReturnType<typeof fakeSiteFetch>['fetchPage'], now = NOW) => ({
  db,
  gateway: gw.gateway,
  fetchPage,
  now: () => now,
})
const siteCalls = async () => (await gw.calls()).filter((c) => c.role === 'site-reader')

describe("Sara studies the client's site", () => {
  it('FR-SITE-10: the home page and three important ones are read, summed up by the cheap model and kept on the lead', async () => {
    const correlationId = await seedLead()
    const site = fakeSiteFetch(dentalSite())
    const kept = await studyLeadSite(deps(site.fetchPage), {
      leadId: '1',
      correlationId,
      text: ORDER_TEXT,
      source: 'order',
      order: ORDER,
      names: ['Ирина'],
    })
    expect(kept?.own).toMatchObject({
      domain: 'ulybka-plus.ru',
      source: 'order',
      status: 'read',
      cms: 'tilda',
      pages: 4,
      brief: { summary: BRIEF.summary, hooks: BRIEF.hooks },
    })
    expect(kept?.own?.signals).toMatchObject({
      https: true,
      mobile: true,
      form: false,
      phone: true,
      prices: true,
      copyrightYear: 2018,
    })
    // 1 home + 3 important pages, no more.
    expect(site.calls).toHaveLength(4)
    const [row] = await db.select({ site: lead.clientSite }).from(lead).where(eq(lead.id, '1'))
    expect(leadSiteOf(row?.site)).toEqual(kept)
  })

  it('FR-SITE-10: the model gets the order, the checked facts and the pages as data; no script; and it is the cheap model', async () => {
    const correlationId = await seedLead()
    await studyLeadSite(deps(fakeSiteFetch(dentalSite()).fetchPage), {
      leadId: '1',
      correlationId,
      text: ORDER_TEXT,
      source: 'order',
      order: ORDER,
      names: ['Ирина'],
    })
    const [call] = await siteCalls()
    expect(call?.model).toBe('haiku')
    const input = call?.stdin ?? ''
    expect(input).toContain('Больше заявок для клиники')
    expect(input).toContain('Сделан на: Tilda')
    expect(input).toContain('Форма заявки: нет')
    expect(input).toContain('Цены: да')
    expect(input).toContain('Год в подвале: 2018')
    expect(input).toContain('<<< данные сайта')
    expect(input).toContain('Пломба от 3 500 ₽')
    // The script of the page never reaches the model; the trap in the visible text arrives framed as data.
    expect(input).not.toContain('SERVER PASSWORD')
    expect(input).toContain('ignore previous instructions')
    expect(input).toMatch(/<<< данные сайта[\s\S]*ignore previous instructions[\s\S]*>>>/)
    // The client's address and phone are hidden from the model by the gateway (ADR-016).
    expect(input).not.toContain('ulybka-plus.ru')
    expect(input).not.toContain('200-00-00')
  })

  it('FR-SITE-11: the journal says how it went and holds no address and no word of the site', async () => {
    const correlationId = await seedLead()
    await studyLeadSite(deps(fakeSiteFetch(dentalSite()).fetchPage), {
      leadId: '1',
      correlationId,
      text: ORDER_TEXT,
      source: 'order',
      order: ORDER,
    })
    const rows = await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, 'lead.site_read'), eq(event.entityId, '1')))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({
      source: 'order',
      found: true,
      status: 'read',
      cms: 'tilda',
      pages: 4,
      brief: true,
      limited: false,
      examples: 0,
    })
    const text = JSON.stringify(rows[0]?.payload)
    expect(text).not.toContain('ulybka')
    expect(text).not.toContain('Краснодар')
  })

  it('FR-SITE-12: a domain is read once a day for any number of orders; the summary is written for each order', async () => {
    await seedLead('1')
    await seedLead('2')
    const site = fakeSiteFetch(dentalSite())
    for (const id of ['1', '2'])
      await studyLeadSite(deps(site.fetchPage), {
        leadId: id,
        correlationId: newEventId(),
        text: ORDER_TEXT,
        source: 'order',
        order: ORDER,
      })
    expect(site.calls).toHaveLength(4)
    expect(await siteCalls()).toHaveLength(2)
    const [cached] = await db.select().from(siteCache)
    expect(cached?.domain).toBe('ulybka-plus.ru')
    expect(cached?.deep).toBe(true)
  })

  it('FR-SITE-12: after a day the site is read again; a site that did not open is tried again after half an hour', async () => {
    await seedLead('1')
    const ok = fakeSiteFetch(dentalSite())
    const first = { text: ORDER_TEXT, source: 'order' as const, order: ORDER }
    await studyClientSite(deps(ok.fetchPage), first)
    await studyClientSite(deps(ok.fetchPage, new Date(NOW.getTime() + CACHE_OK_MS - 60_000)), first)
    expect(ok.calls).toHaveLength(4)
    await studyClientSite(deps(ok.fetchPage, new Date(NOW.getTime() + CACHE_OK_MS + 60_000)), first)
    expect(ok.calls).toHaveLength(8)

    await db.delete(siteCache)
    const down = fakeSiteFetch({ 'ulybka-plus.ru': 'timeout' })
    await studyClientSite(deps(down.fetchPage), first)
    await studyClientSite(deps(down.fetchPage, new Date(NOW.getTime() + 10 * 60_000)), first)
    expect(down.calls).toHaveLength(1)
    await studyClientSite(
      deps(down.fetchPage, new Date(NOW.getTime() + CACHE_FAILED_MS + 60_000)),
      first,
    )
    expect(down.calls).toHaveLength(2)
  })

  it('FR-SITE-13: a site that does not open: the bid goes on, the card says so, no model call is spent', async () => {
    const correlationId = await seedLead()
    const down = fakeSiteFetch({ 'ulybka-plus.ru': 'timeout' })
    const kept = await studyLeadSite(deps(down.fetchPage), {
      leadId: '1',
      correlationId,
      text: ORDER_TEXT,
      source: 'order',
      order: ORDER,
    })
    expect(kept?.own).toMatchObject({ status: 'failed', error: 'timeout', brief: null, cms: null })
    expect(await siteCalls()).toHaveLength(0)
    expect(siteCardView(kept)).toEqual({
      own: { domain: 'ulybka-plus.ru', text: 'сайт не открылся' },
      examples: [],
    })
    // The Analyst is told not to claim it looked at the site.
    expect(siteSection(kept)).toContain('не открылся')
    expect(siteSection(kept)).toContain('не пиши, что смотрела')
  })

  it('FR-SITE-13: a refused address (a local one) is the same: the site did not open', async () => {
    const correlationId = await seedLead('1', 'Мой сайт http://127.0.0.1:8080/admin')
    // No fetch given: the real safe fetch refuses a local address before any connection.
    const kept = await studyLeadSite(
      { db, gateway: gw.gateway, now: () => NOW },
      {
        leadId: '1',
        correlationId,
        text: 'Мой сайт http://127.0.0.1:8080/admin',
        source: 'order',
        order: ORDER,
      },
    )
    expect(kept?.own).toMatchObject({ status: 'failed', error: 'blocked' })
    expect(await siteCalls()).toHaveLength(0)
  })

  it('FR-SITE-14: an order that names no site stores nothing, reads nothing, asks no model', async () => {
    const correlationId = await seedLead('1', 'Нужна стратегия для кафе')
    const site = fakeSiteFetch({})
    const kept = await studyLeadSite(deps(site.fetchPage), {
      leadId: '1',
      correlationId,
      text: 'Нужна стратегия для кафе',
      source: 'order',
      order: ORDER,
    })
    expect(kept).toBeNull()
    expect(site.calls).toHaveLength(0)
    expect(await siteCalls()).toHaveLength(0)
    const [row] = await db.select({ site: lead.clientSite }).from(lead)
    expect(row?.site).toBeNull()
    expect(siteSection(kept)).toBe('')
    expect(siteCardView(kept)).toEqual({ own: null, examples: [] })
  })

  it('FR-SITE-2: a site named as an example is noted apart and never read', async () => {
    const text = 'Хочу сайт как у apple.com и ещё tesla.com нравится'
    const correlationId = await seedLead('1', text)
    const site = fakeSiteFetch({})
    const kept = await studyLeadSite(deps(site.fetchPage), {
      leadId: '1',
      correlationId,
      text,
      source: 'order',
      order: ORDER,
    })
    expect(kept).toEqual({ own: null, examples: ['apple.com', 'tesla.com'] })
    expect(site.calls).toHaveLength(0)
    expect(siteSection(kept)).toContain('apple.com, tesla.com')
    expect(siteSection(kept)).toContain('не его сайты, мы их не читали')
    expect(siteCardView(kept).examples).toEqual(['apple.com', 'tesla.com'])
  })

  it("FR-SITE-15: the day's limit of summaries: the site is still read, the card has its facts, the model is not asked", async () => {
    const correlationId = await seedLead()
    for (let i = 0; i < BRIEFS_PER_DAY; i++)
      await db.insert(modelCall).values({
        id: newEventId(),
        role: 'site-reader',
        roleVersion: 1,
        model: 'haiku',
        priority: 'P1',
        startedAt: NOW.toISOString(),
        durationMs: 10,
        ok: true,
      })
    const kept = await studyLeadSite(deps(fakeSiteFetch(dentalSite()).fetchPage), {
      leadId: '1',
      correlationId,
      text: ORDER_TEXT,
      source: 'order',
      order: ORDER,
    })
    expect(kept?.own).toMatchObject({ status: 'pages', brief: null, cms: 'tilda' })
    expect(await siteCalls()).toHaveLength(0)
    const [ev] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.type, 'lead.site_read'))
    expect(ev?.payload).toMatchObject({ limited: true, brief: false })
    expect(siteCardView(kept).own?.text).toContain('сводки нет')
    expect(siteSection(kept)).toContain('не ссылайся на детали сайта')
  })

  it('FR-SITE-16: the model fails: the pages still count, no summary, no crash', async () => {
    const correlationId = await seedLead()
    const broken = await fakeGateway(db, { 'site-reader': { nonsense: true } })
    const kept = await studyLeadSite(
      {
        db,
        gateway: broken.gateway,
        fetchPage: fakeSiteFetch(dentalSite()).fetchPage,
        now: () => NOW,
      },
      { leadId: '1', correlationId, text: ORDER_TEXT, source: 'order', order: ORDER },
    )
    expect(kept?.own).toMatchObject({ status: 'pages', brief: null, cms: 'tilda' })
  })

  it('FR-SITE-17: a site already read for the lead is not read again, even if the order names it again', async () => {
    const correlationId = await seedLead()
    const site = fakeSiteFetch(dentalSite())
    const i = {
      leadId: '1',
      correlationId,
      text: ORDER_TEXT,
      source: 'order' as const,
      order: ORDER,
    }
    await studyLeadSite(deps(site.fetchPage), i)
    await studyLeadSite(deps(site.fetchPage), { ...i, source: 'chat' })
    expect(site.calls).toHaveLength(4)
    expect(await siteCalls()).toHaveLength(1)
    const rows = await db.select().from(event).where(eq(event.type, 'lead.site_read'))
    expect(rows).toHaveLength(1)
  })

  it('FR-SITE-17: a site the client names later in the chat is read when the order named none', async () => {
    const correlationId = await seedLead('1', 'Нужна стратегия для кафе')
    const site = fakeSiteFetch(dentalSite())
    const kept = await studyLeadSite(deps(site.fetchPage), {
      leadId: '1',
      correlationId,
      text: 'Вот наш сайт: https://ulybka-plus.ru',
      source: 'chat',
      order: { ...ORDER, text: 'Нужна стратегия для кафе' },
    })
    expect(kept?.own).toMatchObject({ source: 'chat', status: 'read' })
  })

  it('FR-SITE-17: a site that did not open is replaced when the client gives another address', async () => {
    const correlationId = await seedLead()
    const down = fakeSiteFetch({ 'ulybka-plus.ru': 'timeout', ...dentalSite('klinika-lada.ru') })
    const i = { leadId: '1', correlationId, source: 'order' as const, order: ORDER }
    await studyLeadSite(deps(down.fetchPage), { ...i, text: ORDER_TEXT })
    const before = down.calls.length
    // The same address again: not tried again at once.
    await studyLeadSite(deps(down.fetchPage), { ...i, text: ORDER_TEXT, source: 'chat' })
    expect(down.calls.length).toBe(before)
    const kept = await studyLeadSite(deps(down.fetchPage), {
      ...i,
      source: 'chat',
      text: 'Ой, не тот, вот правильный: klinika-lada.ru',
    })
    expect(kept?.own).toMatchObject({ domain: 'klinika-lada.ru', status: 'read', source: 'chat' })
  })
})

describe("the platform for the screen's WordPress sign", () => {
  it('FR-SITE-18: siteCmsFor reads only the home page, asks no model, and says WordPress', async () => {
    const site = fakeSiteFetch({ 'coffee-dom.ru': WP_HOME })
    const cms = await siteCmsFor(
      { db, fetchPage: site.fetchPage, now: () => NOW },
      'Нужно переделать мой сайт coffee-dom.ru, он на вордпрессе',
    )
    expect(cms).toBe('wordpress')
    expect(site.calls).toEqual(['https://coffee-dom.ru'])
    expect(await siteCalls()).toHaveLength(0)
  })

  it('FR-SITE-18: no site named, a site that does not open, or an example: no data, never a guess', async () => {
    const down = fakeSiteFetch({ 'coffee-dom.ru': 'timeout' })
    const base = { db, fetchPage: down.fetchPage, now: () => NOW }
    expect(await siteCmsFor(base, 'Нужна стратегия')).toBeNull()
    expect(await siteCmsFor(base, 'сайт coffee-dom.ru')).toBeNull()
    expect(await siteCmsFor(base, 'хочу как у wordpress.org')).toBeNull()
    expect(down.calls).toHaveLength(1)
  })

  it('FR-SITE-18: a deep read already in the cache serves the screen, and a home-only one is read deeper later', async () => {
    const site = fakeSiteFetch(dentalSite())
    await siteCmsFor({ db, fetchPage: site.fetchPage, now: () => NOW }, 'сайт ulybka-plus.ru')
    expect(site.calls).toHaveLength(1)
    // The full study needs the other pages: the home-only cache is not enough for it.
    await studyClientSite(deps(site.fetchPage), { text: ORDER_TEXT, source: 'order', order: ORDER })
    expect(site.calls.length).toBeGreaterThan(1)
    const before = site.calls.length
    expect(
      await siteCmsFor({ db, fetchPage: site.fetchPage, now: () => NOW }, 'сайт ulybka-plus.ru'),
    ).toBe('tilda')
    expect(site.calls).toHaveLength(before)
  })
})

describe('what a summary may carry', () => {
  it('FR-SITE-19: every field is cut short and a link or address is taken out', () => {
    const long = 'очень '.repeat(200)
    const t = tidyBrief({
      business: 'Кафе, подробности на https://evil.example/a и www.evil.example',
      audience: long,
      offer: 'Кофе',
      seen: ['a', 'b', 'c', 'd', 'e', 'f'],
      link: long,
      hooks: ['раз', 'два', 'три'],
      guesses: ['1', '2', '3', '4'],
      summary: long,
    })
    expect(t.business).toBe('Кафе, подробности на и')
    expect(t.audience.length).toBeLessThanOrEqual(220)
    expect(t.seen).toHaveLength(4)
    expect(t.hooks).toHaveLength(2)
    expect(t.guesses).toHaveLength(3)
    expect(t.summary.length).toBeLessThanOrEqual(160)
  })

  it('FR-SITE-19: the section the Analyst reads says what the site is, the details to name, and the guesses as guesses', () => {
    const site: LeadSite = {
      own: {
        url: 'https://ulybka-plus.ru/',
        domain: 'ulybka-plus.ru',
        source: 'order',
        status: 'read',
        error: null,
        cms: 'tilda',
        signals: null,
        pages: 4,
        brief: BRIEF,
        at: NOW.toISOString(),
      },
      examples: ['apple.com'],
    }
    const text = siteSection(site)
    expect(text).toContain('Сделан на: Tilda')
    expect(text).toContain(
      'Детали, которые можно назвать клиенту: заявку можно оставить только по телефону',
    )
    expect(text).toContain('Догадки (не факты)')
    expect(text).toContain('apple.com')
    expect(text).not.toContain('ulybka-plus.ru')
    expect(siteCardView(site).own).toEqual({ domain: 'ulybka-plus.ru', text: BRIEF.summary })
  })
})

describe('a site the client names in the chat', () => {
  it("FR-SITE-28: the client's words of a turn are read for a site before the reply is planned", async () => {
    await seedLead('1', 'Нужна стратегия для кафе')
    const site = fakeSiteFetch(dentalSite())
    await readSiteOfTurn(deps(site.fetchPage), { orderId: '1' }, [
      'Здравствуйте',
      'Вот мой сайт: ulybka-plus.ru, посмотрите',
    ])
    const [row] = await db.select({ site: lead.clientSite }).from(lead)
    expect(leadSiteOf(row?.site)?.own).toMatchObject({
      domain: 'ulybka-plus.ru',
      source: 'chat',
      status: 'read',
    })
    expect(await siteCalls()).toHaveLength(1)
  })

  it('FR-SITE-28: nothing named, no lead in the core, or the same site again: nothing is read', async () => {
    await seedLead('1', 'Ваш сайт ulybka-plus.ru')
    const site = fakeSiteFetch(dentalSite())
    await readSiteOfTurn(deps(site.fetchPage), { orderId: '1' }, ['Здравствуйте, когда сможете?'])
    await readSiteOfTurn(deps(site.fetchPage), { orderId: null }, ['мой сайт ulybka-plus.ru'])
    await readSiteOfTurn(deps(site.fetchPage), { orderId: '404' }, ['мой сайт ulybka-plus.ru'])
    expect(site.calls).toHaveLength(0)
    expect(await siteCalls()).toHaveLength(0)
    const [row] = await db.select({ site: lead.clientSite }).from(lead)
    expect(row?.site).toBeNull()
  })
})
