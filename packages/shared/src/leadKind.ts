import type { DirectionRules } from './contracts/direction'

/**
 * The kind of an order by its Profi.ru category, one function for everything that compares a score with a
 * threshold: «Маркетинг» is what Hance is first of all, «Сайты» a side line, «Остальное» the rest. Regular
 * expressions on the category, case ignored; the first match wins in the order of the checks below.
 */
export const LEAD_KINDS = ['marketing', 'sites', 'other'] as const
export type LeadKind = (typeof LEAD_KINDS)[number]

export const LEAD_KIND_TITLES: Record<LeadKind, string> = {
  marketing: 'Маркетинг',
  sites: 'Сайты',
  other: 'Остальное',
}

/**
 * What carries a marketing word but is customs, law, a marketplace, an ad setup or a designer's job, not Hance's
 * strategy (the misses of the first pass over the real categories, 3.11).
 */
const NOT_MARKETING = new RegExp(
  [
    'маркетплейс|wildberries|ozon|карточ|телемаркет',
    'яндекс.?маркет|менеджер яндекс',
    'брокер|продаж[аеи]? бизнес|франшиз',
    'вэд|таможен|окпд|регистрация ип|субсиди|карьерн|project manager|дроблен',
    'авито|авитолог|настройка рекламы|аудит рекламн|seo-?аудит|сео-?аудит|аудит сайта',
    'дизайнер|лукбук',
    'аудитор|аналитик|яндекс бизнес|обзвон|хассп|ресторан|социолог|бизнес-процесс',
  ].join('|'),
  'i',
)
const MARKETING =
  /маркет|стратег|бизнес|консалт|консульт|бренд|упаков|позицион|анализ рынка|анализ целев|анализ конкур|привлечение клиент|отдел продаж|нейминг|лидоген|исследован|аудит/i
/** A channel is an execution, not a strategy: it is «Остальное» even when it comes with a site. */
const CHANNEL =
  /^smm|^смм|таргет|директ|контекст|^seo|^сео|seo-|авито|контент|продвижен|реклам|пиар|аналитик|поведенческ|оптимизаци.* сайт|микроразметк|промокод|работа с заказами/i
const SITES = /сайт|лендинг|landing|интернет-магазин|wordpress|tilda|тильд|битрикс|веб-/i

export function leadKind(category: string | null | undefined): LeadKind {
  const c = (category ?? '').trim()
  if (c === '' || NOT_MARKETING.test(c)) return 'other'
  if (MARKETING.test(c)) return 'marketing'
  if (CHANNEL.test(c)) return 'other'
  if (SITES.test(c)) return 'sites'
  return 'other'
}

/** The threshold of an order's kind under the rules; the plain `threshold` for a kind the rules do not set. */
export function thresholdFor(
  rules: Pick<DirectionRules, 'threshold' | 'kind_thresholds'>,
  category: string | null | undefined,
): number {
  return rules.kind_thresholds?.[leadKind(category)] ?? rules.threshold
}
