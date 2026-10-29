import { describe, expect, it } from 'vitest'
import { ago, count, pct, toCsv, waited, waitTone } from '../src/app/format'
import { idOf, queryOf, sectionOf } from '../src/app/router'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const before = (min: number) => new Date(NOW - min * 60_000).toISOString()

describe('the words of the pult', () => {
  it('NFR-UX-1: time ago reads like Boris says it, without a trailing dot', () => {
    expect(ago(before(0), NOW)).toBe('сейчас')
    expect(ago(before(4), NOW)).toBe('4 мин назад')
    expect(ago(before(150), NOW)).toBe('2 ч назад')
    expect(ago(before(30 * 60), NOW)).toMatch(/^вчера \d\d:\d\d$/)
    expect(ago(before(5 * 24 * 60), NOW)).toBe('23 окт')
    expect(ago(null, NOW)).toBe('нет данных')
  })

  it('FR-LEAD-10: a lead shows how long it waits and its color: calm to an hour, warn to four, bad after', () => {
    expect(waited(before(25), NOW)).toBe('ждёт 25 мин')
    expect(waited(before(190), NOW)).toBe('ждёт 3 ч')
    expect(waitTone(before(59), NOW)).toBe('ok')
    expect(waitTone(before(61), NOW)).toBe('warn')
    expect(waitTone(before(241), NOW)).toBe('bad')
  })

  it('NFR-UX-1: counts and shares in Russian', () => {
    expect(count(1, ['дело', 'дела', 'дел'])).toBe('1 дело')
    expect(count(3, ['дело', 'дела', 'дел'])).toBe('3 дела')
    expect(count(11, ['дело', 'дела', 'дел'])).toBe('11 дел')
    expect(pct(41.5)).toBe('41,5%')
    expect(pct(null)).toBe('нет')
  })

  it('FR-ANL-5: the table download opens in Excel: BOM, semicolons, quoted cells', () => {
    const csv = toCsv([
      ['Месяц', 'Клиент'],
      ['Октябрь', 'ООО «Ромашка»; филиал'],
      ['Ноябрь', null],
    ])
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.slice(1).split('\n')).toEqual([
      'Месяц;Клиент',
      'Октябрь;"ООО «Ромашка»; филиал"',
      'Ноябрь;',
    ])
  })
})

describe('the paths of the pult', () => {
  it('FR-UI-2: every path has its section and a thing has one home', () => {
    expect(sectionOf('/')).toBe('inbox')
    expect(sectionOf('/today')).toBe('today')
    expect(sectionOf('/leads/95210417')).toBe('leads')
    expect(sectionOf('/accounts/hance-marketing/direction')).toBe('accounts')
    expect(sectionOf('/search?q=анна')).toBe('search')
    expect(idOf('/leads/95210417', 'leads')).toBe('95210417')
    expect(idOf('/leads', 'leads')).toBeNull()
    expect(idOf('/mind/K-014', 'mind')).toBe('K-014')
    expect(idOf('/clients/c%201', 'clients')).toBe('c 1')
    expect(queryOf('/search?q=%D0%B0%D0%BD%D0%BD%D0%B0')).toBe('анна')
    expect(queryOf('/search')).toBe('')
  })
})
