import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type AnalystOutput, ProfiOrder } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import type { Gateway, RoleCallResult } from '../src/gateway/gateway'
import {
  callOfferTemplate,
  fillCallOffer,
  isApprovedText,
  isCallOffer,
  SLOTS_MARK,
  slotsText,
  type WorkHours,
  workHoursSlots,
} from '../src/leads/callSlots'
import { followUpsOf, writeDraft } from '../src/leads/draft'
import { chosenSites, isSiteOrder, sitesOf, sitesText } from '../src/leads/siteOrder'
import { type LeadCard, leadCardText } from '../src/notify/cards'

// The call offer and the sites of an order of a site (Boris, 30.10.2026). Clients and texts are invented; the sites are
// the ones Boris gave to be shown to clients.
const ROOT = resolve(import.meta.dirname, '../../..')
/** A moment by its Moscow wall clock (UTC+3). */
const msk = (iso: string) => new Date(`${iso}+03:00`)
const WORK: WorkHours = {
  hours: { from: 11, to: 19 },
  days: [1, 2, 3, 4, 5],
  slotMin: 30,
  minAheadMin: 120,
  night: { from: 23, to: 8 },
}
const times = (now: Date) => slotsText(workHoursSlots(now, WORK), now)

describe('the call offer: three times by Boris’s working hours', () => {
  // 29.10.2026 is a Thursday, 30.10 a Friday, 2.11 a Monday.
  it('FR-LEAD-6: a morning offer gives three times of today, an hour apart at least, two hours ahead at least', () => {
    expect(times(msk('2026-10-29T09:00'))).toBe('сегодня в 11:00, 15:00 или 18:30')
    expect(times(msk('2026-10-29T12:10'))).toBe('сегодня в 14:30, 16:30 или 18:30')
  })

  it('FR-LEAD-6: when today has too little time left, the times are tomorrow’s, never a mix', () => {
    expect(times(msk('2026-10-29T16:00'))).toBe('завтра в 11:00, 15:00 или 18:30')
    expect(times(msk('2026-10-29T22:30'))).toBe('завтра в 11:00, 15:00 или 18:30')
  })

  it('FR-LEAD-6: no time on a day off: Friday evening and the weekend offer Monday', () => {
    expect(times(msk('2026-10-30T17:00'))).toBe('в понедельник в 11:00, 15:00 или 18:30')
    expect(times(msk('2026-10-31T10:00'))).toBe('в понедельник в 11:00, 15:00 или 18:30')
  })

  it('FR-LEAD-6: the hours, the days and the step come from the settings', () => {
    const short = { ...WORK, hours: { from: 10, to: 13 }, days: [1, 2, 3, 4, 5, 6, 7] }
    const now = msk('2026-10-31T07:00')
    expect(slotsText(workHoursSlots(now, short), now)).toBe('сегодня в 10:00, 11:30 или 12:30')
    // Hours shorter than three times an hour apart: the next day with any, as many as it has.
    const tiny = { ...WORK, hours: { from: 11, to: 12 } }
    expect(workHoursSlots(msk('2026-10-29T09:00'), tiny)).toHaveLength(1)
    expect(workHoursSlots(msk('2026-10-29T09:00'), { ...WORK, days: [] })).toEqual([])
  })

  it('FR-CONV-5: the offer Boris approved goes with its times put in, and only those may differ', () => {
    const template = callOfferTemplate('Сайт для клиники')
    expect(isCallOffer(template)).toBe(true)
    expect(template).toContain('полчас')
    expect(callOfferTemplate('Сайт для клиники')).toBe(template)
    const now = msk('2026-10-29T09:00')
    const sent = fillCallOffer(template, workHoursSlots(now, WORK), now)
    expect(sent).toContain('сегодня в 11:00, 15:00 или 18:30')
    expect(sent).not.toContain(SLOTS_MARK)
    expect(isApprovedText(template, sent)).toBe(true)
    expect(isApprovedText(template, `${sent} И ещё приписка`)).toBe(false)
    expect(isApprovedText(template, 'Совсем другой текст')).toBe(false)
    expect(isApprovedText('Из недавнего)', 'Из недавнего)')).toBe(true)
    expect(isApprovedText('Из недавнего)', 'Из недавнего))')).toBe(false)
  })
})

const RECORD = `# Сайты Hance для показа клиенту

Как показывать: ...

## Стальной Каркас

- Ссылка: https://zmksk.ru/
- Подпись: металлоконструкции, корпоративный сайт
- Что: многостраничный корпоративный сайт производителя металлоконструкций.
- Показывать: производство, стройка, B2B.
- Кейс: k-case-16

## Бубочка

- Ссылка: https://bubochkabrand.ru/
- Подпись: магазин детской одежды на Tilda
- Что: интернет-магазин на Tilda.
- Показывать: магазин на Tilda, бренд одежды.

## Royalty Teams

- Ссылка: https://www.royalty-teams.ru/
- Подпись: сайт IT-компании
- Что: лендинг IT-компании.
- Показывать: IT, услуги для бизнеса.

## Cognio

- Ссылка: https://hance.pro/cognio/
- Подпись: сервис диагностики навыков
- Что: страница продукта.
- Показывать: онлайн-сервис, обучение.

## Levkorz

- Ссылка: https://levkorz.ru/
- Подпись: интернет-магазин
- Что: интернет-магазин на Яндекс КИТ.
- Показывать: e-commerce.`
const SITES = sitesOf(RECORD)

describe('an order of a site (Boris, 30.10.2026)', () => {
  it('FR-LEAD-6: an order to make or remake a site is told from one to promote it', () => {
    const o = (title: string, category = '', text = '') => ({ title, category, text })
    expect(isSiteOrder(o('Нужен сайт для стоматологии'))).toBe(true)
    expect(isSiteOrder(o('Переделать лендинг школы танцев'))).toBe(true)
    expect(isSiteOrder(o('Создание интернет-магазина одежды'))).toBe(true)
    expect(isSiteOrder(o('Помощь с бизнесом', 'Создание сайтов'))).toBe(true)
    expect(isSiteOrder(o('Сайт под ключ на Tilda'))).toBe(true)
    expect(isSiteOrder(o('SEO продвижение сайта', 'Продвижение сайтов'))).toBe(false)
    expect(isSiteOrder(o('Маркетинговая стратегия для кафе', 'Маркетинг'))).toBe(false)
  })

  it('FR-LEAD-6: the sites of the record are read with their links and labels, ids by address', () => {
    expect(SITES.map((s) => s.id)).toEqual([
      'zmksk.ru',
      'bubochkabrand.ru',
      'royalty-teams.ru',
      'hance.pro/cognio',
      'levkorz.ru',
    ])
    expect(SITES[0]).toMatchObject({
      name: 'Стальной Каркас',
      url: 'https://zmksk.ru/',
      label: 'металлоконструкции, корпоративный сайт',
    })
    expect(sitesText(SITES)).toContain('[hance.pro/cognio] Cognio')
    expect(sitesText([])).toBe('')
  })

  it('FR-LEAD-6: 3-4 sites are shown: those chosen first, topped up in the record’s order, never more than four', () => {
    expect(chosenSites(SITES, ['bubochkabrand.ru']).map((s) => s.id)).toEqual([
      'bubochkabrand.ru',
      'zmksk.ru',
      'royalty-teams.ru',
    ])
    expect(
      chosenSites(SITES, [
        'levkorz.ru',
        'https://www.royalty-teams.ru',
        'nope.ru',
        'zmksk.ru',
        'hance.pro/cognio',
        'bubochkabrand.ru',
      ]).map((s) => s.id),
    ).toEqual(['levkorz.ru', 'royalty-teams.ru', 'zmksk.ru', 'hance.pro/cognio'])
  })

  it('FR-LEAD-6: the series of an order of a site opens with the sites, a link a line with its niche, then the words', () => {
    const r = followUpsOf(
      [{ text: 'Вот несколько наших сайтов, из недавнего)', case_id: null }],
      [],
      {
        offered: SITES,
        ids: ['bubochkabrand.ru', 'hance.pro/cognio', 'royalty-teams.ru'],
      },
    )
    expect(r.texts).toEqual([
      [
        'https://bubochkabrand.ru/ - магазин детской одежды на Tilda',
        'https://hance.pro/cognio/ - сервис диагностики навыков',
        'https://www.royalty-teams.ru/ - сайт IT-компании',
      ].join('\n'),
      'Вот несколько наших сайтов, из недавнего)',
    ])
    expect(r.siteIds).toEqual(['bubochkabrand.ru', 'hance.pro/cognio', 'royalty-teams.ru'])
  })

  it('FR-LEAD-6: the Analyst of an order of a site reads the sites and its chosen ones lead the series', async () => {
    const order = ProfiOrder.parse(
      JSON.parse(await readFile(join(ROOT, 'tests/fixtures/orders/90000001.json'), 'utf8')),
    )
    const inputs: string[] = []
    const out: AnalystOutput = {
      reading: { said: 'a', layers: 'b', wants: 'c', who: 'd', risks: 'e', job: 'f' },
      hidden_need: 'Запуститься без долгой стройки',
      risk: 'Объём',
      condition: 'Брать',
      text: 'Прочитал описание: клинике нужен сайт на Tilda из пяти блоков с онлайн записью.\n\nКогда хотите запуститься?',
      price_rub: 35000,
      follow_ups: [{ text: 'Вот несколько наших сайтов, из недавнего)', case_id: null }],
      site_ids: ['zmksk.ru', 'royalty-teams.ru', 'bubochkabrand.ru'],
    }
    const gw: Gateway = {
      async call<T>(_role: string, input: string): Promise<RoleCallResult<T>> {
        inputs.push(input)
        return { ok: true, output: out as T, durationMs: 1, modelCallId: 'm' }
      },
    }
    const r = await writeDraft(gw, order, { now: msk('2026-10-29T12:00'), sites: SITES })
    expect(inputs[0]).toContain('Заказ на создание или переделку сайта')
    expect(r).toMatchObject({
      followUpSites: ['zmksk.ru', 'royalty-teams.ru', 'bubochkabrand.ru'],
    })
    expect(r.text === null ? [] : r.followUps?.[0]?.split('\n')).toHaveLength(3)
  })
})

describe('the card shows the call offer last', () => {
  it('FR-LEAD-6: the offer stands under the series, its times in words, the note says they go in at sending', () => {
    const card: LeadCard = {
      taskId: '00000000-0000-4000-8000-000000000001',
      orderId: '90000001',
      title: 'Сайт для клиники',
      city: 'Краснодар',
      budgetText: null,
      clientName: 'Анна',
      text: 'Нужен сайт клиники.',
      verdict: 'fit',
      reason: 'Нужен сайт',
      bidPriceRub: 240,
      draft: {
        text: 'Анна, добрый день!\n\nПрочитал описание',
        priceRub: 35000,
        followUps: ['Из недавнего)', callOfferTemplate('x')],
      },
    }
    const html = leadCardText(card)
    expect(html.indexOf('📞 Созвон')).toBeGreaterThan(html.indexOf('Из недавнего)'))
    expect(html).toContain('<i>[три времени по рабочим часам]</i>')
    expect(html).not.toContain(SLOTS_MARK)
    expect(html).toContain('Время созвона Сара подставит при отправке')
  })
})
