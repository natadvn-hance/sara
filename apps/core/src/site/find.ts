import { domainToUnicode } from 'node:url'

/**
 * The sites a client names in an order or a message: his own (to read) and the ones he gives as examples he likes
 * («хочу как у apple.com»), which are only noted. No network: the words around each address decide.
 */
export type FoundSites = {
  /** The client's own sites, at most two, the first is the one to read: a full http(s) address. */
  own: string[]
  /** The domains of other sites, examples or competitors, at most five. */
  examples: string[]
}

const TLDS = [
  'ru',
  'рф',
  'su',
  'рус',
  'москва',
  'moscow',
  'com',
  'net',
  'org',
  'info',
  'biz',
  'pro',
  'io',
  'me',
  'online',
  'site',
  'shop',
  'store',
  'app',
  'dev',
  'by',
  'kz',
  'uz',
  'kg',
  'am',
  'ge',
  'az',
  'ua',
  'cc',
  'tech',
  'agency',
  'studio',
  'design',
  'club',
  'space',
  'top',
  'xyz',
  'website',
  'center',
  'group',
  'company',
  'market',
  'art',
  'life',
  'fun',
  'today',
  'expert',
  'team',
  'school',
  'academy',
  'travel',
  'beauty',
  'clinic',
  'health',
  'fit',
  'ltd',
  'world',
  'digital',
  'media',
  'events',
  'house',
  'land',
  'one',
  'plus',
  'tv',
  'co',
  'de',
  'eu',
  'uk',
  'us',
  'ai',
  'page',
  'link',
  'ws',
  'to',
  'ee',
  'lv',
  'lt',
  'cz',
  'pl',
  'fi',
  'it',
  'fr',
  'es',
  'ca',
] as const

// No quotes, brackets or «» inside an address: they close it in a sentence.
const URL_CHAR = `[^\\s<>"'«»()\\[\\]{}|\\\\^\`]`
const LABEL = '[a-z0-9а-яё](?:[a-z0-9а-яё-]{0,61}[a-z0-9а-яё])?'
const TLD = `(?:${TLDS.join('|')})`
/** With a scheme or www any case goes; a bare domain only in lower case, so «ASP.NET» and «Node.js» stay words. */
const ADDRESS = new RegExp(
  [
    `\\bhttps?://${URL_CHAR}+`,
    `(?<![\\p{L}\\p{N}@._/-])www\\.${URL_CHAR}+`,
    `(?<![\\p{L}\\p{N}@._/-])(?:${LABEL}\\.)+${TLD}(?![\\p{L}\\p{N}-])(?:[/?#]${URL_CHAR}*)?`,
  ].join('|'),
  'giu',
)

/**
 * Hosts that are no client's own site: the platform itself, social networks and messengers, marketplaces, file and
 * document hosts, maps. A mini site builder (taplink) is a site.
 */
const NOT_A_SITE = [
  'profi.ru',
  'vk.com',
  'vk.ru',
  'vkontakte.ru',
  'ok.ru',
  'm.vk.com',
  't.me',
  'telegram.me',
  'telegram.org',
  'wa.me',
  'whatsapp.com',
  'instagram.com',
  'facebook.com',
  'fb.com',
  'youtube.com',
  'youtu.be',
  'rutube.ru',
  'tiktok.com',
  'dzen.ru',
  'zen.yandex.ru',
  'pinterest.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'wildberries.ru',
  'wb.ru',
  'ozon.ru',
  'avito.ru',
  'market.yandex.ru',
  'megamarket.ru',
  'aliexpress.ru',
  'aliexpress.com',
  'disk.yandex.ru',
  'disk.yandex.com',
  'docs.google.com',
  'drive.google.com',
  'google.com',
  'yandex.ru',
  'ya.ru',
  'mail.ru',
  'cloud.mail.ru',
  'dropbox.com',
  'figma.com',
  'miro.com',
  'notion.so',
  'hh.ru',
  '2gis.ru',
  'yandex.com',
  'apps.apple.com',
  'play.google.com',
  'rustore.ru',
  'gosuslugi.ru',
]

/** «Хочу как у …», «нравится», «пример», competitors: the address that follows is someone else's site. */
const EXAMPLE_CUE =
  /(?<!\p{L})(?:как\s+(?:у|на|в)|нравит|понрав|пример|например|референс|в\s+стиле|по\s+типу|наподобие|аналог|конкурент|вроде|ориентир|образец|образц|похож|вдохнов)/giu
/** «Мой сайт», «наш магазин», «сайт:», «есть сайт»: the address that follows is the client's own. */
const OWN_CUE =
  /(?<!\p{L})(?:мо[йяеи]|наш[аеи]?|у\s+нас|сайт\s*[:-]|адрес\s+сайта|ссылка\s+на\s+(?:наш\s+|мой\s+)?сайт|текущ|существующ|действующ|сейчас|есть|имеется|сайт\s+компании|сайт\s+магазина)(?!\p{L})/giu
/** Words right after an address that make it an example: «apple.com нравится», «x.ru как пример». */
const EXAMPLE_AFTER =
  /^[\s,:-]{0,3}(?:\(?\s*)?(?:нравит|понрав|как\s+пример|для\s+примера|пример)/iu

/** The host of an address in lower case and Unicode, without www; null when it is no address of a site. */
export function hostOf(address: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    const host = domainToUnicode(u.hostname)
      .toLowerCase()
      .replace(/^www\./, '')
    return host.includes('.') ? host : null
  } catch {
    return null
  }
}

const isNotASite = (host: string) => NOT_A_SITE.some((h) => host === h || host.endsWith(`.${h}`))

/** The address as a full link: a scheme for a bare domain, the end of the sentence left out. */
function linkOf(raw: string): string {
  const trimmed = raw.replace(/[.,;:!?]+$/u, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** The cue nearest before the address in its sentence, and whether words after it make it an example. */
function kindOf(text: string, start: number, end: number): 'own' | 'example' {
  const before = text.slice(0, start)
  // The sentence: back to a line break, «!», «?» or a period followed by a space (a domain's dot has none).
  const boundary = Math.max(
    before.lastIndexOf('\n'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
    before.search(/\.\s(?!.*\.\s)/su),
  )
  const sentence = before.slice(boundary + 1)
  const last = (re: RegExp) => {
    let at = -1
    for (const m of sentence.matchAll(re)) at = m.index ?? at
    return at
  }
  const example = last(EXAMPLE_CUE)
  const own = last(OWN_CUE)
  if (example > own) return 'example'
  if (EXAMPLE_AFTER.test(text.slice(end, end + 30))) return 'example'
  return 'own'
}

/**
 * The client's own sites and the examples in a text. An address with no cue around it is taken for the client's own:
 * a client attaches his site far more often than a bare link to someone else's (the cue then says so).
 */
export function findSites(text: string): FoundSites {
  const own: string[] = []
  const examples: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(ADDRESS)) {
    const raw = m[0]
    const start = m.index ?? 0
    // An e-mail's domain is no site: «info@shop.ru».
    if (text[start - 1] === '@') continue
    // A bare domain only in lower case: «example.ru» is a site, «ASP.NET» is a technology.
    if (!/^(?:https?:\/\/|www\.)/i.test(raw) && /\p{Lu}/u.test(raw.split(/[/?#]/u)[0] ?? ''))
      continue
    const link = linkOf(raw)
    const host = hostOf(link)
    if (!host || isNotASite(host) || seen.has(host)) continue
    seen.add(host)
    if (kindOf(text, start, start + raw.length) === 'example') {
      if (examples.length < 5) examples.push(host)
    } else if (own.length < 2) own.push(link)
  }
  return { own, examples }
}
