import type { MindSearch } from '../conversation/types'
import { listItems } from '../mind/cases'
import { markdownSections } from '../mind/loader'
import type { DraftSource } from './draft'

/**
 * An order for a site (Boris, 30.10.2026): «если это создание сайта, то отклик должен быть чуть более техническим и в
 * догоне приложить наши примеры, 3-4 сайта классных под задачу». The sites are the mind record `k-sites-portfolio`:
 * Boris sent their links to be given to clients.
 */

/** The mind record of the sites of Hance a client may be shown. */
export const SITES_RECORD = 'k-sites-portfolio'

/** A site of Hance from the record; `id` is its address without the scheme, «zmksk.ru», «hance.pro/cognio». */
export type HanceSite = {
  id: string
  name: string
  url: string
  /** A few words of its niche, shown beside the link: «металлоконструкции, корпоративный сайт». */
  label: string
  what: string
  when: string
}

/** The fewest and the most sites an order of a site is shown. */
export const SITES_SHOWN = { min: 3, max: 4 } as const

/** «Создание сайтов», «Лендинги», «Сайт на Tilda»: a category of making sites, not of promoting them. */
const SITE_CATEGORY = /сайт|лендинг|landing|веб.?дизайн|интернет.?магазин|tilda|тильд/iu
const PROMOTION = /продвижен|seo|контекст|реклам|smm|таргет/iu
/** A verb of making or remaking close before the site: «нужен сайт», «переделать лендинг», «создание интернет-магазина». */
const MAKE_SITE =
  /(?:созда|разработ|сдела|нуж[еноа]|передела|редизайн|обнов|сверста|собра|запуст|заказ)[\p{L}]*[^.!?\n]{0,40}?(?:сайт|лендинг|landing|интернет.?магазин)/iu
const SITE_HOW =
  /(?:сайт|лендинг)[^.!?\n]{0,30}?(?:под ключ|с нуля|на tilda|на тильд|на wordpress)/iu

/** Whether the order is for making or remaking a site: by its category, or by what its title and text ask for. */
export function isSiteOrder(o: Pick<DraftSource, 'title' | 'category' | 'text'>): boolean {
  const asked = `${o.title}\n${o.text}`
  if (MAKE_SITE.test(asked) || SITE_HOW.test(asked)) return true
  return SITE_CATEGORY.test(o.category) && !PROMOTION.test(o.category)
}

const idOf = (url: string): string | null => {
  try {
    const u = new URL(url)
    return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase()
  } catch {
    return null
  }
}

/** The sites of the record: a section a site, its items «Ссылка», «Подпись», «Что», «Показывать». */
export function sitesOf(body: string): HanceSite[] {
  const sites: HanceSite[] = []
  for (const [name, section] of Object.entries(markdownSections(body))) {
    const field = (key: string) =>
      listItems(section)
        .find((i) => i.toLowerCase().startsWith(`${key.toLowerCase()}:`))
        ?.slice(key.length + 1)
        .trim() ?? ''
    const url = field('Ссылка')
    const id = idOf(url)
    if (!id || !/^https:\/\//.test(url)) continue
    sites.push({
      id,
      name,
      url,
      label: field('Подпись'),
      what: field('Что'),
      when: field('Показывать'),
    })
  }
  return sites
}

/** The sites of Hance for an order of a site; none for any other order, or when the mind cannot be read. */
export async function sitesForBid(
  mind: Pick<MindSearch, 'byIds'> | undefined,
  o: Pick<DraftSource, 'title' | 'category' | 'text'>,
): Promise<HanceSite[]> {
  if (!mind || !isSiteOrder(o)) return []
  try {
    const [record] = await mind.byIds([SITES_RECORD])
    return record ? sitesOf(record.body) : []
  } catch (e) {
    console.error('sites of the mind failed', e instanceof Error ? e.message : e)
    return []
  }
}

/** The sites as the Analyst reads them for an order of a site; nothing when there are none. */
export function sitesText(sites: HanceSite[]): string {
  if (sites.length === 0) return ''
  return [
    'Заказ на создание или переделку сайта (раздел «Заказ на сайт» твоих правил). Сайты Hance, которые можно показать, id в квадратных скобках:',
    ...sites.map((s) => `[${s.id}] ${s.name}: ${s.what} Показывать: ${s.when}`),
  ].join('\n')
}

/**
 * The sites the series shows: those the answer chose among the offered, in its order and once each, topped up to the
 * fewest in the record's order (Boris wants 3-4), the most at the cap.
 */
export function chosenSites(sites: HanceSite[], ids: readonly string[] | undefined): HanceSite[] {
  const picked: HanceSite[] = []
  for (const id of ids ?? []) {
    const s = sites.find((x) => x.id === id.toLowerCase().replace(/^https?:\/\/(www\.)?/, ''))
    if (s && !picked.includes(s)) picked.push(s)
  }
  for (const s of sites) if (picked.length < SITES_SHOWN.min && !picked.includes(s)) picked.push(s)
  return picked.slice(0, SITES_SHOWN.max)
}

/** A site as a line of the message of links, as Boris wrote them: «https://zmksk.ru/ - металлоконструкции». */
export const siteLine = (s: HanceSite) => (s.label ? `${s.url} - ${s.label}` : s.url)

/** The same address, whatever the scheme, «www.» or the last slash. */
export const sameUrl = (a: string, b: string) => idOf(a) !== null && idOf(a) === idOf(b)
