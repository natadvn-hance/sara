import { type LeadSite, type LinkDigest, newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lead } from '../../src/db/schema'
import { analysisMessages, type LeadCard, renderLeadCard } from '../../src/notify/cards'
import type { Fetched } from '../../src/site/fetch'
import { findLinks } from '../../src/site/find'
import { leadSiteOf, studyLeadSite } from '../../src/site/lead'
import { tidyDigest } from '../../src/site/links'
import { siteLines, studiedLine } from '../../src/site/view'
import { openTestDb, resetDb } from '../helpers/db'
import { type FakeGateway, fakeGateway } from '../helpers/gateway'
import { DENTAL_HOME } from './fakeSite'

const { db, close } = openTestDb()
afterAll(close)

const DOC = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit'
const SHEET = 'https://docs.google.com/spreadsheets/d/9ZyXwVuTsRqPoNmL/edit#gid=0'
const DIGEST: LinkDigest = {
  valuable: ['в ТЗ важен запуск за две недели', 'нужна запись онлайн'],
  cares: ['скорость запуска'],
  missing: ['бюджет не указан'],
  hooks: ['по вашему ТЗ видно, что для вас важна скорость запуска'],
  summary: 'ТЗ: запуск за две недели, онлайн запись, бюджета нет',
}
const TEXT = `Нужен сайт. ТЗ тут ${DOC} и таблица ${SHEET}. Хочу как у apple.com`
const ORDER = { title: 'Сайт для клиники', category: 'Сайты', text: TEXT }

let gw: FakeGateway
beforeEach(async () => {
  await resetDb(db)
  gw = await fakeGateway(db, { 'links-digest': DIGEST })
})
const seed = async (text = TEXT) => {
  const correlationId = newEventId()
  await db.insert(lead).values({
    id: '1',
    accountId: 'hance-marketing',
    title: ORDER.title,
    category: ORDER.category,
    city: 'Краснодар',
    text,
    clientName: 'Ирина',
    bidPriceRub: 210,
    seenAt: new Date().toISOString(),
    correlationId,
  })
  return correlationId
}
/** Open documents answer with text, a closed one with a login page, apple.com with a page. */
const net = (closed = false) => {
  const calls: string[] = []
  const fetchPage = async (url: string): Promise<Fetched> => {
    calls.push(url)
    if (url.includes('/document/d/'))
      return closed
        ? {
            ok: true,
            url,
            html: '<html><body>Войдите в аккаунт Google</body></html>',
            truncated: false,
          }
        : {
            ok: true,
            url,
            html: 'ТЗ. Запуск за две недели. Нужна запись онлайн. Бюджет не указан.',
            truncated: false,
          }
    if (url.includes('/spreadsheets/d/'))
      return { ok: true, url, html: 'услуга,цена\nпломба,3500', truncated: false }
    if (url.startsWith('https://apple.com'))
      return { ok: true, url, html: DENTAL_HOME, truncated: false }
    return { ok: false, error: 'http_404', url }
  }
  return { fetchPage, calls }
}
const calls = async () => (await gw.calls()).filter((c) => c.role === 'links-digest')

describe('the other links of an order', () => {
  it('FR-LINK-1: documents, social pages and unreadable files are told apart; a Google Doc is read by its text export', () => {
    const l = findLinks(
      `ТЗ ${DOC}, таблица ${SHEET}, макет https://www.figma.com/file/abc, группа vk.com/mycafe, диск https://disk.yandex.ru/d/x`,
    )
    expect(l).toEqual([
      {
        kind: 'doc',
        domain: 'docs.google.com',
        readUrl: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/export?format=txt',
      },
      {
        kind: 'doc',
        domain: 'docs.google.com',
        readUrl: 'https://docs.google.com/spreadsheets/d/9ZyXwVuTsRqPoNmL/export?format=csv',
      },
      { kind: 'doc', domain: 'figma.com', readUrl: null },
      { kind: 'social', domain: 'vk.com', readUrl: 'https://vk.com/mycafe' },
    ])
  })

  it('FR-LINK-2: the documents and the example are read, summed up in one cheap call, and kept on the lead', async () => {
    const correlationId = await seed()
    const n = net()
    const site = await studyLeadSite(
      { db, gateway: gw.gateway, fetchPage: n.fetchPage },
      { leadId: '1', correlationId, text: TEXT, source: 'order', order: ORDER },
    )
    expect(site?.links?.map((l) => [l.kind, l.domain, l.opened])).toEqual([
      ['doc', 'docs.google.com', true],
      ['doc', 'docs.google.com', true],
      ['example', 'apple.com', true],
    ])
    expect(site?.digest).toEqual(DIGEST)
    expect(site?.examples).toEqual(['apple.com'])
    expect(n.calls.filter((u) => u.includes('export?format=')).length).toBe(2)
    const [call] = await calls()
    expect(call?.model).toBe('haiku')
    expect(call?.stdin).toContain('Запуск за две недели')
    expect(call?.stdin).toContain('<<< данные ссылки')
    expect(call?.stdin).not.toContain('1AbCdEfGhIjKlMnOp')
    // Kept, and not read again when the same text comes again.
    const [row] = await db.select({ s: lead.clientSite }).from(lead)
    expect(leadSiteOf(row?.s)?.digest).toEqual(DIGEST)
    const before = n.calls.length
    await studyLeadSite(
      { db, gateway: gw.gateway, fetchPage: n.fetchPage },
      { leadId: '1', correlationId, text: TEXT, source: 'chat', order: ORDER },
    )
    expect(n.calls.length).toBe(before)
    expect(await calls()).toHaveLength(1)
  })

  it('FR-LINK-3: a closed document is a link that did not open; no valuable fact, no model call, the card says so', async () => {
    const correlationId = await seed(`ТЗ ${DOC}`)
    const site = await studyLeadSite(
      { db, gateway: gw.gateway, fetchPage: net(true).fetchPage },
      { leadId: '1', correlationId, text: `ТЗ ${DOC}`, source: 'order', order: ORDER },
    )
    expect(site?.links?.[0]).toMatchObject({ opened: false, error: 'login_required' })
    expect(site?.digest ?? null).toBeNull()
    expect(await calls()).toHaveLength(0)
    expect(studiedLine(site)).toBe('не открылось: 1')
    expect(siteLines(site).join('\n')).toContain('не пиши, что изучала их')
  })

  it('FR-LINK-4: an unreadable file (Figma) is noted, never fetched', async () => {
    const t = 'Макет https://www.figma.com/file/abc'
    const correlationId = await seed(t)
    const n = net()
    const site = await studyLeadSite(
      { db, gateway: gw.gateway, fetchPage: n.fetchPage },
      { leadId: '1', correlationId, text: t, source: 'order', order: ORDER },
    )
    expect(site?.links?.[0]).toMatchObject({
      domain: 'figma.com',
      opened: false,
      error: 'login_required',
    })
    expect(n.calls).toHaveLength(0)
  })

  it('FR-LINK-5: the Analyst and the conversation get the valuable facts, the card a line «Изучила», «Разбор» the block', async () => {
    const correlationId = await seed()
    const site = (await studyLeadSite(
      { db, gateway: gw.gateway, fetchPage: net().fetchPage },
      { leadId: '1', correlationId, text: TEXT, source: 'order', order: ORDER },
    )) as LeadSite
    const text = siteLines(site).join('\n')
    expect(text).toContain(
      'Ценное для задачи: в ТЗ важен запуск за две недели; нужна запись онлайн',
    )
    expect(text).toContain('Чего не хватает: бюджет не указан')
    expect(text).toContain('Детали, которые можно назвать клиенту: по вашему ТЗ видно')
    const card: LeadCard = {
      taskId: 't',
      orderId: '1',
      title: 'Сайт',
      city: 'К',
      budgetText: null,
      clientName: 'Ирина',
      text: 'Нужен сайт',
      verdict: 'fit',
      reason: 'x',
      bidPriceRub: 210,
      site,
    }
    expect(renderLeadCard(card).html).toContain(
      '📎 <b>Изучила:</b> 3 ссылки · ТЗ: запуск за две недели, онлайн запись, бюджета нет',
    )
    expect(analysisMessages(card).join('\n')).toContain('Ценное из ссылок и файлов')
  })

  it('FR-LINK-6: the sum-up is cut short and holds no address', () => {
    const t = tidyDigest({
      valuable: ['a https://evil.example/x b', 'b', 'c', 'd', 'e'],
      cares: [],
      missing: [],
      hooks: ['1', '2', '3'],
      summary: 'x'.repeat(400),
    })
    expect(t.valuable[0]).toBe('a b')
    expect(t.valuable).toHaveLength(4)
    expect(t.hooks).toHaveLength(2)
    expect(t.summary.length).toBeLessThanOrEqual(160)
  })
})
