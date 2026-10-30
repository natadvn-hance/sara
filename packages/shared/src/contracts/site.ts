import { z } from 'zod'

/**
 * The client's own site (Boris, 30.10.2026: «если клиент приложил свой сайт, Сара будет изучать сайт, сопоставлять
 * его с заявкой и выстраивать свой ответ на основе изученного сайта»). The core reads it from the server's own exit
 * (never the node's tab, never the account's exit), the code notes what it sees in the pages, and a cheap model call
 * sums it up against the order.
 */

/** What the site is built on, by signs in its code; the screen's criterion «WordPress» may lean on `wordpress`. */
export const SITE_CMS = [
  'tilda',
  'wordpress',
  'bitrix',
  'wix',
  'joomla',
  'opencart',
  'insales',
  'shopify',
  'webflow',
  'taplink',
  'ucoz',
  'creatium',
  'flexbe',
  'nethouse',
  'lpgenerator',
  'ukit',
  'modx',
  'drupal',
  'nextjs',
] as const
export const SiteCms = z.enum(SITE_CMS)
export type SiteCms = z.infer<typeof SiteCms>

/** How Boris and a client name each platform. */
export const SITE_CMS_RU: Record<SiteCms, string> = {
  tilda: 'Tilda',
  wordpress: 'WordPress',
  bitrix: '1С-Битрикс',
  wix: 'Wix',
  joomla: 'Joomla',
  opencart: 'OpenCart',
  insales: 'InSales',
  shopify: 'Shopify',
  webflow: 'Webflow',
  taplink: 'Taplink',
  ucoz: 'uCoz',
  creatium: 'Creatium',
  flexbe: 'Flexbe',
  nethouse: 'Nethouse',
  lpgenerator: 'LPgenerator',
  ukit: 'uKit',
  modx: 'MODX',
  drupal: 'Drupal',
  nextjs: 'Next.js',
}

/** What the code saw in the pages it read, no model: each a plain fact of the HTML. */
export const SiteSignals = z.object({
  /** The last page answered over https. */
  https: z.boolean(),
  /** A viewport meta tag: the page is made for a phone's screen. */
  mobile: z.boolean(),
  /** A form to leave a request, or a known form or quiz widget. */
  form: z.boolean(),
  /** A phone number or a tel: link. */
  phone: z.boolean(),
  /** A link to WhatsApp, Telegram or Viber. */
  messenger: z.boolean(),
  /** A sum in rubles or a word of price next to a number. */
  prices: z.boolean(),
  /** Words of cases, portfolio, works or reviews. */
  cases: z.boolean(),
  /** The latest year after ©; null when the pages show none. */
  copyrightYear: z.number().int().nullable(),
})
export type SiteSignals = z.infer<typeof SiteSignals>

/** The model's short reading of the site against the order (role site-reader). Only what the pages show. */
export const SiteBrief = z.object({
  /** What the business is, one phrase. */
  business: z.string(),
  /** Whom it sells to, as the site shows it. */
  audience: z.string(),
  /** What it offers. */
  offer: z.string(),
  /** What is seen at once (no prices, no form, a weak first screen...), at most four short facts. */
  seen: z.array(z.string()),
  /** How the site bears on the task of the order. */
  link: z.string(),
  /** One or two details of the site a bid may name to the client, tied to the task. */
  hooks: z.array(z.string()),
  /** Guesses, each marked as such. */
  guesses: z.array(z.string()),
  /** One line for the card: the business and the main thing that bears on the task. */
  summary: z.string(),
})
export type SiteBrief = z.infer<typeof SiteBrief>

/**
 * How the reading went: `read` the pages and the brief; `pages` the pages were read but no brief (the day's limit of
 * model calls, or the model did not answer); `failed` the site did not open (`error` says why).
 */
export const SiteReadStatus = z.enum(['read', 'pages', 'failed'])
export type SiteReadStatus = z.infer<typeof SiteReadStatus>

/** The client's own site as Sara read it for one lead. */
export const SiteRead = z.object({
  url: z.string(),
  domain: z.string(),
  /** Where it was found: the order's text or a client's message in the chat. */
  source: z.enum(['order', 'chat']),
  status: SiteReadStatus,
  /** Why it did not open (`timeout`, `blocked`, `http_404`, `not_html`...); null when it did. */
  error: z.string().nullable(),
  cms: SiteCms.nullable(),
  signals: SiteSignals.nullable(),
  /** How many pages were read: the home page and up to three important ones. */
  pages: z.number().int().nonnegative(),
  brief: SiteBrief.nullable(),
  at: z.iso.datetime(),
})
export type SiteRead = z.infer<typeof SiteRead>

/** What a link of an order is: by where it points. */
export const LINK_KINDS = ['example', 'doc', 'social', 'other'] as const
export const LinkKind = z.enum(LINK_KINDS)
export type LinkKind = z.infer<typeof LinkKind>

/**
 * One more link of the order or the chat (Boris, 30.10.2026 evening: «если в откликах лежат какие-то ссылки … эту
 * информацию нужно будет изучать перед откликом»): a site the client likes, a competitor, an open document, a page in a
 * social network. Read without a login, only its first page; `opened` false: it did not open (or needs a login).
 */
export const LinkRead = z.object({
  kind: LinkKind,
  domain: z.string(),
  opened: z.boolean(),
  error: z.string().nullable(),
  /** The title of the page or document; short. */
  title: z.string().nullable(),
})
export type LinkRead = z.infer<typeof LinkRead>

/** The model's sum-up of what the links (and files) hold that matters for the task; only what they show. */
export const LinkDigest = z.object({
  /** What is valuable for the task, at most four short facts. */
  valuable: z.array(z.string()),
  /** What the client himself treats as important. */
  cares: z.array(z.string()),
  /** What is missing for a good answer. */
  missing: z.array(z.string()),
  /** One or two details a bid may name, human, tied to the task. */
  hooks: z.array(z.string()),
  /** One line for the card. */
  summary: z.string(),
})
export type LinkDigest = z.infer<typeof LinkDigest>

/**
 * The sites of a lead (`lead.client_site`): the client's own, read; and the sites he named as examples he likes
 * («хочу как у …»), only their domains, never read.
 */
export const LeadSite = z.object({
  own: SiteRead.nullable(),
  examples: z.array(z.string()),
  /** The other links of the order, read (Boris, 30.10.2026 evening); absent on a lead from before. */
  links: z.array(LinkRead).optional(),
  /** What is valuable in the links, for the Analyst; null: nothing to sum up. */
  digest: LinkDigest.nullable().optional(),
})
export type LeadSite = z.infer<typeof LeadSite>
