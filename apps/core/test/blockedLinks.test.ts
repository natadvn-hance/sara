import { SETTINGS } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { caseLink, publicLink } from '../src/conversation/caseLink'
import { bidCasesText } from '../src/leads/bidCases'
import { followUpsOf } from '../src/leads/draft'
import { sitesForBid } from '../src/leads/siteOrder'
import { hasBlockedLink, seriesWithoutBlocked, stripBlockedLinks } from '../src/text/blockedLinks'
import { caseOf } from './helpers/conversation'

// Links a client is never given (Boris, 30.10.2026: «сайт нексум не рабочий, его отправлять не нужно»).
const BLOCKED = ['nexum.su']

/** A case with a site in «Материалы» that its rules let be given. */
const withSite = (id: string, title: string, url: string) => {
  const c = caseOf(id, title, { showRules: ['Компанию и ссылку можно называть.'] })
  return { ...c, body: `${c.body}\n\n## Материалы\n\n${url}` }
}
const NEXUM = withSite('k-case-19', 'NEXUM: сайт и SEO', 'https://nexum.su/')
const CLINIC = withSite('k-case-01', 'Лиса-Клиник: онлайн-запись', 'https://lisa-clinic.example/')

describe('links a client is never given', () => {
  it('FR-LEAD-6: nexum.su is on the list from the start, and the list is a setting', () => {
    expect(SETTINGS['links.blocked'].default).toEqual(['nexum.su'])
    expect(SETTINGS['links.blocked'].schema.safeParse(['nexum.su', 'hance.pro/old']).success).toBe(
      true,
    )
    expect(SETTINGS['links.blocked'].schema.safeParse(['']).success).toBe(false)
  })

  it('FR-LEAD-6: a link of the list is found however it is written, another site is not', () => {
    for (const t of [
      'https://nexum.su/',
      'http://www.nexum.su/about',
      'Смотрите nexum.su, там всё',
      'НЕКСУМ https://NEXUM.SU/Case',
      'ссылка (https://nexum.su)',
    ])
      expect(hasBlockedLink(t, BLOCKED), t).toBe(true)
    for (const t of [
      'https://lisa-clinic.example/',
      'https://mynexum.su/',
      'https://nexum.supplies/',
      'про nexum без сайта',
    ])
      expect(hasBlockedLink(t, BLOCKED), t).toBe(false)
    // An entry with a path blocks only that address.
    expect(hasBlockedLink('https://hance.pro/old/page', ['hance.pro/old'])).toBe(true)
    expect(hasBlockedLink('https://hance.pro/cognio/', ['hance.pro/old'])).toBe(false)
    // An empty list, a too short entry: nothing is blocked.
    expect(hasBlockedLink('https://nexum.su/', [])).toBe(false)
    expect(hasBlockedLink('https://nexum.su/', ['ab'])).toBe(false)
  })

  it('FR-LEAD-6: a link of the list is cut out of a text; a series loses the lines that hold one', () => {
    expect(stripBlockedLinks('Смотрите https://nexum.su/ и ещё', BLOCKED)).toBe('Смотрите  и ещё')
    expect(
      seriesWithoutBlocked(
        [
          'https://nexum.su/ - сайт\nhttps://zmksk.ru/ - металлоконструкции',
          'https://nexum.su/',
          'Из недавнего)',
        ],
        BLOCKED,
      ),
    ).toEqual(['https://zmksk.ru/ - металлоконструкции', 'Из недавнего)'])
    expect(seriesWithoutBlocked(['Из недавнего)'], [])).toEqual(['Из недавнего)'])
  })

  it('FR-LEAD-6: the link of a case on the list is never its public link, in a bid or in a reply', () => {
    expect(publicLink(NEXUM)).toBe('https://nexum.su/')
    expect(publicLink(NEXUM, BLOCKED)).toBeNull()
    expect(publicLink(CLINIC, BLOCKED)).toBe('https://lisa-clinic.example/')
    expect(caseLink(NEXUM, 'asked', BLOCKED)).toBeNull()
    expect(caseLink(CLINIC, 'asked', BLOCKED)).toBe('https://lisa-clinic.example/')
    // The Analyst is told which cases have a link to show: NEXUM has none now.
    const text = bidCasesText([NEXUM, CLINIC], BLOCKED)
    expect(text.match(/Публичная ссылка: нет/g)).toHaveLength(1)
    expect(text.match(/Публичная ссылка: есть/g)).toHaveLength(1)
  })

  it('FR-LEAD-6: a series that names the case on the list shows no link for it, and the rest stays', () => {
    const r = followUpsOf(
      [
        { text: 'Из недавнего, похожая задача)', case_id: 'k-case-19' },
        { text: 'Сделаем быстро)', case_id: null },
      ],
      [NEXUM, CLINIC],
      { offered: [], ids: [] },
      BLOCKED,
    )
    expect(r.texts).toEqual(['Сделаем быстро)'])
    expect(r.caseIds).toEqual([])
    expect(r.dropped).toEqual(['no_link'])
    // Without the list the same answer would have shown it: the check is the list's.
    expect(followUpsOf([{ text: 'Из недавнего)', case_id: 'k-case-19' }], [NEXUM]).texts[0]).toBe(
      'https://nexum.su/',
    )
  })

  it('FR-LEAD-6: a site of the list is not offered for an order of a site', async () => {
    const record = [
      '# Сайты',
      '## NEXUM',
      '- Ссылка: https://nexum.su/',
      '- Подпись: сайт',
      '- Что: сайт.',
      '- Показывать: всегда.',
      '## Стальной Каркас',
      '- Ссылка: https://zmksk.ru/',
      '- Подпись: металлоконструкции',
      '- Что: сайт.',
      '- Показывать: стройка.',
    ].join('\n')
    const mind = { byIds: async () => [{ body: record }] as never }
    const o = { title: 'Нужен сайт для клиники', category: '', text: '' }
    expect((await sitesForBid(mind, o)).map((s) => s.id)).toEqual(['nexum.su', 'zmksk.ru'])
    expect((await sitesForBid(mind, o, BLOCKED)).map((s) => s.id)).toEqual(['zmksk.ru'])
  })
})
