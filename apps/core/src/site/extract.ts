import type { SiteCms, SiteSignals } from '@sara/shared'

/**
 * What the code reads out of a page's HTML, with no browser and no script run: the words a visitor sees, the links
 * to the site's important pages, what the site is built on and plain facts (a form, a phone, prices).
 */
export type PageText = {
  url: string
  title: string
  description: string
  /** The h1-h3 headings, in order. */
  headings: string[]
  /** The visible text, line by line, repeats left out. */
  text: string
}

export type PageSigns = Omit<SiteSignals, 'https'>

/** The kinds of pages worth reading after the home page, in the order they are taken. */
const IMPORTANT: { kind: string; re: RegExp }[] = [
  { kind: 'services', re: /услуг|uslug|services?\b|napravlen|направлени/iu },
  { kind: 'prices', re: /цен[аыу]|прайс|стоимост|тариф|price|tseny|ceny|stoimost|tarif/iu },
  {
    kind: 'about',
    re: /(?<!\p{L})о\s+(?:нас|компани|клиник|студи|центр|проект|школ|магазин|бренд|команд)|(?<!\p{L})(?:about|team|company|kompaniya)(?!\p{L})|\bo-(?:nas|kompanii|klinike|studii|centre|proekte|shkole|magazine)\b|kto-my/iu,
  },
  {
    kind: 'cases',
    re: /кейс|портфолио|наши\s+работы|проекты|portfolio|cases|works|projects|keys/iu,
  },
  { kind: 'catalog', re: /каталог|catalog|products|товары|shop\b/iu },
]

const NOT_A_PAGE = /\.(?:pdf|jpe?g|png|gif|webp|svg|docx?|xlsx?|pptx?|zip|rar|mp4|mp3)(?:[?#]|$)/i

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  laquo: '«',
  raquo: '»',
  mdash: '-',
  ndash: '-',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bdquo: '„',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  middot: '·',
  bull: '•',
  rub: '₽',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1]?.toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const noComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, ' ')
/** Everything a visitor never reads as text: scripts, styles, pictures drawn in code, templates. */
const noCode = (html: string) =>
  html.replace(
    /<(script|style|noscript|svg|template|iframe|canvas|object)\b[\s\S]*?<\/\1\s*>/gi,
    ' ',
  )

const plainText = (fragment: string) =>
  decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()

/** The visible text: block tags as line breaks, the rest of the markup gone, every line once. */
function visibleText(body: string): string {
  const lines = decodeEntities(
    body
      .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
      .replace(
        /<\/?(?:p|div|li|ul|ol|h[1-6]|section|article|header|footer|nav|tr|td|th|table|form|label|button|a)\b[^>]*>/gi,
        '\n',
      )
      .replace(/<[^>]*>/g, ' '),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1)
  const seen = new Set<string>()
  return lines
    .filter((l) => {
      if (seen.has(l)) return false
      seen.add(l)
      return true
    })
    .join('\n')
}

const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
    .exec(tag)
    ?.slice(1)
    .find((v) => v !== undefined) ?? null

export function pageText(html: string, url: string): PageText {
  const clean = noCode(noComments(html))
  const title = plainText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(clean)?.[1] ?? '')
  const metaDescription = [...clean.matchAll(/<meta\b[^>]*>/gi)]
    .map((m) => m[0])
    .find(
      (t) =>
        /\bname\s*=\s*["']?description/i.test(t) || /\bproperty\s*=\s*["']?og:description/i.test(t),
    )
  const description = metaDescription
    ? decodeEntities(attr(metaDescription, 'content') ?? '').trim()
    : ''
  const headings = [...clean.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)]
    .map((m) => plainText(m[2] ?? ''))
    .filter((h) => h !== '')
  const body = /<body\b[^>]*>([\s\S]*)/i.exec(clean)?.[1] ?? clean
  return {
    url,
    title,
    description,
    headings: [...new Set(headings)].slice(0, 20),
    text: visibleText(body),
  }
}

/** The host of a link without www, lower case; null for a link that is not to a web page. */
const hostKey = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, '')

/**
 * The site's own important pages linked from this one: services, prices, about, cases, catalog, one of each kind in
 * that order, at most `max`. Links to files, anchors of the same page and other sites are left out.
 */
export function importantLinks(html: string, pageUrl: string, max = 3): string[] {
  const base = new URL(pageUrl)
  const found = new Map<string, string>()
  for (const m of noComments(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attr(m[1] ?? '', 'href')
    if (!href || /^(?:#|mailto:|tel:|javascript:|whatsapp:|viber:)/i.test(href)) continue
    let u: URL
    try {
      u = new URL(decodeEntities(href), base)
    } catch {
      continue
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || hostKey(u) !== hostKey(base))
      continue
    if (NOT_A_PAGE.test(u.pathname)) continue
    u.hash = ''
    if (u.pathname === base.pathname && u.search === base.search) continue
    const words = `${decodeURIComponent(u.pathname)} ${plainText(m[2] ?? '')}`
    for (const { kind, re } of IMPORTANT) {
      if (!found.has(kind) && re.test(words)) {
        found.set(kind, u.toString())
        break
      }
    }
  }
  const links = IMPORTANT.map(({ kind }) => found.get(kind)).filter((l): l is string => !!l)
  return [...new Set(links)].slice(0, max)
}

/** Signs in the code, the meta generator first: the first platform whose sign is found. */
const CMS_SIGNS: [SiteCms, RegExp][] = [
  ['tilda', /tildacdn\.com|\btilda\.ws\b|data-tilda-|t-records/],
  ['wordpress', /\/wp-content\/|\/wp-includes\/|wp-json|wp-emoji/],
  ['bitrix', /\/bitrix\/(?:js|templates|cache|components)|bx\.setcsslist|bitrix_sessid|bx_/],
  ['wix', /static\.wixstatic\.com|wix\.com website builder|_wixcssimports|parastorage\.com/],
  ['joomla', /\/media\/jui\/|\/components\/com_|joomla!/],
  ['opencart', /catalog\/view\/theme|index\.php\?route=/],
  ['insales', /insales-cdn|\binsales\.ru|insales\.com/],
  ['shopify', /cdn\.shopify\.com|shopify\.theme/],
  ['webflow', /webflow\.js|data-wf-page|website-files\.com/],
  ['taplink', /taplink\.(?:cc|ru|at)/],
  ['ucoz', /ucoz\.(?:ru|net|com)|\/\.s\/src\//],
  ['creatium', /creatium/],
  ['flexbe', /flexbe/],
  ['nethouse', /nethouse/],
  ['lpgenerator', /lpgenerator/],
  ['ukit', /ukit\.(?:com|me)|static\.ukit/],
  ['modx', /modx/],
  ['drupal', /drupal\.settings|data-drupal-|\/sites\/default\/files\//],
  ['nextjs', /__next_data__|\/_next\/static\//],
]

const GENERATOR: [SiteCms, RegExp][] = [
  ['tilda', /tilda/],
  ['wordpress', /wordpress/],
  ['bitrix', /bitrix|битрикс/],
  ['wix', /wix/],
  ['joomla', /joomla/],
  ['opencart', /opencart/],
  ['modx', /modx/],
  ['drupal', /drupal/],
  ['webflow', /webflow/],
  ['ucoz', /ucoz/],
]

export function cmsOf(html: string): SiteCms | null {
  const lower = html.toLowerCase()
  const generator = [...lower.matchAll(/<meta\b[^>]*>/g)]
    .map((m) => m[0])
    .find((t) => /\bname\s*=\s*["']?generator/.test(t))
  const content = generator ? (attr(generator, 'content') ?? '') : ''
  const byGenerator = GENERATOR.find(([, re]) => re.test(content))?.[0]
  if (byGenerator) return byGenerator
  return CMS_SIGNS.find(([, re]) => re.test(lower))?.[0] ?? null
}

const FORM_WIDGET =
  /\bt-form\b|tn-form|b24-form|marquiz|amoforms|wpcf7|ws-form|flexbe-form|uform|js-form-proccess|bitrix24.*form|data-form/i
const PHONE = /(?:\+7|(?<!\d)8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/
const PRICE = /\d[\d\s.,]*\s?(?:₽|руб\.?|р\.(?!\p{L}))|(?:цена|стоимость|от)\s*:?\s*\d[\d\s]{2,}/iu
const CASES = /(?<!\p{L})(?:кейс|портфолио|наши\s+работы|наши\s+проекты|реализованн|отзыв)/iu

/** Plain facts of one page; a site's facts are any of its pages'. */
export function pageSigns(html: string, text: string, now: Date): PageSigns {
  const clean = noComments(html)
  const forms = [...clean.matchAll(/<form\b[\s\S]*?<\/form\s*>/gi)].map((m) => m[0])
  const leadForm = forms.some(
    (f) =>
      /<textarea\b/i.test(f) ||
      /<input\b[^>]*type\s*=\s*["']?(?:tel|email)/i.test(f) ||
      (/<input\b/i.test(f) &&
        !/type\s*=\s*["']?search|name\s*=\s*["']?(?:q|s|search)["'\s>]/i.test(f)),
  )
  const years = [
    ...text.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-\u2013\u2014]\s*)?(\d{4})/giu),
  ]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 1995 && y <= now.getUTCFullYear() + 1)
  return {
    mobile: /<meta\b[^>]*name\s*=\s*["']?viewport/i.test(clean),
    form: leadForm || FORM_WIDGET.test(clean),
    phone: /href\s*=\s*["']?tel:/i.test(clean) || PHONE.test(text),
    messenger:
      /wa\.me\/|api\.whatsapp\.com|whatsapp:\/\/|\bt\.me\/|telegram\.me\/|viber:\/\//i.test(clean),
    prices: PRICE.test(text),
    cases: CASES.test(text),
    copyrightYear: years.length > 0 ? Math.max(...years) : null,
  }
}

/** The facts of several pages together: a sign on any page counts, the latest copyright year. */
export function mergeSigns(all: PageSigns[]): PageSigns {
  const years = all.map((s) => s.copyrightYear).filter((y): y is number => y !== null)
  return {
    mobile: all[0]?.mobile ?? false,
    form: all.some((s) => s.form),
    phone: all.some((s) => s.phone),
    messenger: all.some((s) => s.messenger),
    prices: all.some((s) => s.prices),
    cases: all.some((s) => s.cases),
    copyrightYear: years.length > 0 ? Math.max(...years) : null,
  }
}
