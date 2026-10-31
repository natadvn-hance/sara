import { describe, expect, it } from 'vitest'
import { findSites, hostOf } from '../../src/site/find'

describe("the client's site in an order or a message", () => {
  it("FR-SITE-1: «мой сайт example.ru» is the client's own site", () => {
    const r = findSites('Нужна реклама. Мой сайт example.ru, заявок с него мало.')
    expect(r.own).toEqual(['https://example.ru'])
    expect(r.examples).toEqual([])
  })

  it('FR-SITE-1: a full link, a www link and a Cyrillic domain are found', () => {
    expect(findSites('Сайт: https://shop-xyz.ru/catalog?a=1').own).toEqual([
      'https://shop-xyz.ru/catalog?a=1',
    ])
    expect(findSites('наш сайт www.kofe-dom.com').own).toEqual(['https://www.kofe-dom.com'])
    expect(findSites('сайт: магазин-цветов.рф.').own).toEqual(['https://магазин-цветов.рф'])
  })

  it("FR-SITE-1: an address with no cue around it is taken for the client's own", () => {
    expect(findSites('Вот: mebel-plus.ru').own).toEqual(['https://mebel-plus.ru'])
  })

  it('FR-SITE-2: «хочу как у apple.com» is an example the client likes, not his site', () => {
    const r = findSites('Хочу сайт как у apple.com, но для мебели')
    expect(r.own).toEqual([])
    expect(r.examples).toEqual(['apple.com'])
  })

  it('FR-SITE-2: an own site and an example in one text are told apart', () => {
    const r = findSites(
      'Мой сайт example.ru. Нравится дизайн, например, tesla.com и https://stripe.com/',
    )
    expect(r.own).toEqual(['https://example.ru'])
    expect(r.examples).toEqual(['tesla.com', 'stripe.com'])
  })

  it('FR-SITE-2: a word after the address makes it an example', () => {
    const r = findSites('Нужен сайт. dyson.com нравится.')
    expect(r.own).toEqual([])
    expect(r.examples).toEqual(['dyson.com'])
  })

  it('FR-SITE-2: an example in a sentence of its own does not turn the next own site into an example', () => {
    const r = findSites('Хочу как у apple.com. Мой сайт example.ru')
    expect(r.own).toEqual(['https://example.ru'])
    expect(r.examples).toEqual(['apple.com'])
  })

  it('FR-SITE-3: social networks, the platform, marketplaces and file hosts are no site', () => {
    const r = findSites(
      'Группа vk.com/mycafe, телеграм t.me/mycafe, https://www.instagram.com/mycafe, ссылка на ТЗ https://docs.google.com/document/d/1, диск disk.yandex.ru/d/x, профи profi.ru/backoffice/n.php?o=1, товары на ozon.ru/seller/1',
    )
    expect(r).toEqual({ own: [], examples: [] })
  })

  it('FR-SITE-3: an e-mail address and a technology name are no site', () => {
    expect(findSites('Пишите на info@example.ru')).toEqual({ own: [], examples: [] })
    expect(findSites('Нужен бэкенд на ASP.NET и Node.js')).toEqual({ own: [], examples: [] })
    expect(findSites('Версия 3.5 и цена 1.500.000 руб')).toEqual({ own: [], examples: [] })
  })

  it('FR-SITE-3: only http and https, no credentials, the same domain once', () => {
    expect(findSites('ftp://files.example.ru/a').own).toEqual([])
    expect(findSites('https://user:pass@example.ru/').own).toEqual([])
    expect(findSites('example.ru и снова https://www.example.ru/about').own).toEqual([
      'https://example.ru',
    ])
  })

  it('FR-SITE-1: at most two own sites and five examples', () => {
    const own = findSites('a1.ru a2.ru a3.ru').own
    expect(own).toHaveLength(2)
    const ex = findSites('как у b1.com, b2.com, b3.com, b4.com, b5.com, b6.com, b7.com').examples
    expect(ex).toHaveLength(5)
  })

  it('FR-SITE-1: the host is lower case, without www, in Unicode', () => {
    expect(hostOf('https://WWW.Example.RU/x')).toBe('example.ru')
    expect(hostOf('https://xn--80aswg.xn--p1ai')).toBe('сайт.рф')
    expect(hostOf('mailto:a@b.ru')).toBeNull()
    expect(hostOf('http://localhost')).toBeNull()
  })
})
