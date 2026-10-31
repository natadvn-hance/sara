import { describe, expect, it } from 'vitest'
import {
  cmsOf,
  decodeEntities,
  importantLinks,
  mergeSigns,
  pageSigns,
  pageText,
} from '../../src/site/extract'
import { DENTAL_HOME, WP_HOME } from './fakeSite'

const NOW = new Date('2026-10-30T10:00:00Z')

describe('what the code reads out of a page', () => {
  it('FR-SITE-6: the visible text, title, description and headings; scripts and styles never', () => {
    const p = pageText(DENTAL_HOME, 'https://ulybka-plus.ru/')
    expect(p.title).toBe('Улыбка Плюс - стоматология в Краснодаре')
    expect(p.description).toContain('протезирование')
    expect(p.headings).toEqual(['Стоматология Улыбка Плюс', 'Лечим зубы без боли для всей семьи'])
    expect(p.text).toContain('Звоните')
    expect(p.text).not.toContain('SERVER PASSWORD')
    expect(p.text).not.toContain('t-body{margin')
    expect(p.text).not.toContain('<')
  })

  it('FR-SITE-6: entities are decoded', () => {
    expect(decodeEntities('Кофе&nbsp;&amp;&nbsp;чай &laquo;Дом&raquo; &#8381; &#x41;')).toBe(
      'Кофе & чай «Дом» ₽ A',
    )
  })

  it('FR-SITE-7: the platform is read from the code: Tilda, WordPress by the generator tag and by paths, Bitrix', () => {
    expect(cmsOf(DENTAL_HOME)).toBe('tilda')
    expect(cmsOf(WP_HOME)).toBe('wordpress')
    expect(
      cmsOf('<html><head><script src="/wp-content/plugins/a.js"></script></head></html>'),
    ).toBe('wordpress')
    expect(cmsOf('<link href="/bitrix/templates/main/styles.css">')).toBe('bitrix')
    expect(cmsOf('<meta name="generator" content="Joomla! - Open Source">')).toBe('joomla')
    expect(cmsOf('<html><body>просто страница</body></html>')).toBeNull()
  })

  it('FR-SITE-7: the generator tag outranks a path that only mentions another platform', () => {
    const html = '<meta name="generator" content="Tilda"><p>статья про /wp-content/ и WordPress</p>'
    expect(cmsOf(html)).toBe('tilda')
  })

  it('FR-SITE-8: the facts of a page: phone yes, form no, prices no, phone-friendly, the year', () => {
    const text = pageText(DENTAL_HOME, 'https://ulybka-plus.ru/').text
    const s = pageSigns(DENTAL_HOME, text, NOW)
    expect(s).toEqual({
      mobile: true,
      form: false,
      phone: true,
      messenger: false,
      prices: false,
      cases: false,
      copyrightYear: 2018,
    })
  })

  it('FR-SITE-8: a form with a phone input and a messenger link are seen; a search form is not a request form', () => {
    const text = pageText(WP_HOME, 'https://coffee.ru/').text
    const s = pageSigns(WP_HOME, text, NOW)
    expect(s.form).toBe(true)
    expect(s.messenger).toBe(true)
    expect(s.mobile).toBe(false)
    const search = '<form action="/s"><input type="search" name="q"></form>'
    expect(pageSigns(search, 'поиск', NOW).form).toBe(false)
  })

  it('FR-SITE-8: prices, cases and a copyright range are noticed; a year in the future is not', () => {
    const s = pageSigns(
      '<html></html>',
      'Пломба от 3 500 ₽. Наши работы. © 2015-2024 Фирма. Звоните 8 (800) 555-35-35',
      NOW,
    )
    expect(s.prices).toBe(true)
    expect(s.cases).toBe(true)
    expect(s.phone).toBe(true)
    expect(s.copyrightYear).toBe(2024)
    expect(pageSigns('<html></html>', '© 2099 Фирма', NOW).copyrightYear).toBeNull()
  })

  it('FR-SITE-8: the facts of several pages together: any page counts, the latest year wins', () => {
    const a = pageSigns('<html></html>', 'главная © 2018', NOW)
    const b = pageSigns('<html></html>', 'Цена от 100 ₽ © 2024', NOW)
    const m = mergeSigns([a, b])
    expect(m.prices).toBe(true)
    expect(m.copyrightYear).toBe(2024)
  })

  it('FR-SITE-9: the important pages: services, prices, about, one of each, not files, anchors or other sites', () => {
    const links = importantLinks(DENTAL_HOME, 'https://ulybka-plus.ru/', 3)
    expect(links).toEqual([
      'https://ulybka-plus.ru/uslugi',
      'https://ulybka-plus.ru/ceny',
      'https://ulybka-plus.ru/o-klinike',
    ])
    expect(importantLinks(DENTAL_HOME, 'https://ulybka-plus.ru/', 2)).toHaveLength(2)
    const mixed = `<a href="https://evil.example/uslugi">услуги</a><a href="/price.pdf">цены</a><a href="/">главная</a><a href="javascript:x()">цены</a>`
    expect(importantLinks(mixed, 'https://ulybka-plus.ru/')).toEqual([])
  })
})
