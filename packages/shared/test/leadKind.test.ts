import { describe, expect, it } from 'vitest'
import { leadKind, thresholdFor } from '../src'

describe('the kind of an order by its category (3.11)', () => {
  it('FR-LEAD-3: strategy and marketing words make marketing', () => {
    for (const c of [
      'Маркетинг',
      'Маркетолог',
      'Маркетинговая стратегия',
      'Привлечение клиентов',
      'Лидогенерация b2b',
      'Брендинг',
      'Нейминг фирмы',
      'Бизнес-консалтинг',
      'Консультация маркетолога',
    ])
      expect(leadKind(c), c).toBe('marketing')
  })

  it('FR-LEAD-3: sites, landing pages and shops make sites', () => {
    for (const c of [
      'Создание сайтов',
      'Сайт Тильда',
      'Landing page',
      'Разработка интернет-магазина',
      'Доработка сайта на Bitrix',
      'Веб-программист',
    ])
      expect(leadKind(c), c).toBe('sites')
  })

  it('FR-LEAD-3: a channel is the rest even when it names a site or a marketing word', () => {
    for (const c of [
      'Продвижение сайта',
      'SEO-продвижение',
      'Настройка Яндекс.Директ',
      'Таргетированная реклама',
      'Авитолог',
      'Продвижение на Авито',
      'Услуги по продвижению сайтов',
      'Реклама сайта/приложения',
    ])
      expect(leadKind(c), c).toBe('other')
  })

  it('FR-LEAD-3: marketplaces, customs, law and a designer are the rest, not marketing', () => {
    for (const c of [
      'Размещение на маркетплейсах',
      'Создание карточек Ozon',
      'Менеджер яндекс маркета',
      'Консультация по рекламе Яндекс Маркет',
      'ВЭД консультации',
      'Таможенное оформление',
      'Регистрация ИП и консультация по открытию бизнеса',
      'Брокер по продаже бизнеса',
      'Дизайнер брендбука',
      'Телемаркетинг',
      'Seo аудит сайта',
      'Бизнес-аналитик',
      '',
    ])
      expect(leadKind(c), c).toBe('other')
    expect(leadKind(null)).toBe('other')
  })

  it('FR-LEAD-3: the threshold is the kind’s own, and the plain one for a kind that is not set', () => {
    const rules = { threshold: 50, kind_thresholds: { marketing: 40, sites: 55 } }
    expect(thresholdFor(rules, 'Маркетолог')).toBe(40)
    expect(thresholdFor(rules, 'Создание сайтов')).toBe(55)
    expect(thresholdFor(rules, 'Авитолог')).toBe(50)
    expect(thresholdFor({ threshold: 56 }, 'Маркетолог')).toBe(56)
  })
})
