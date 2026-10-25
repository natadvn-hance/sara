import type { CheckInput, CheckIssue } from '../types'
import { CASE_AD_PHRASES, CASE_CLAIM, CASE_LINK } from './phrases'

/**
 * The code checks of a case in a reply (cases in a conversation, docs/product/cases-in-negotiation.md): only a case
 * of this turn's list, with a moment, not told before, one at a time, with nothing the show rules close, no ad words
 * and no link written by the model. Pure functions over the reply's text and the turn's cases.
 */

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')
const plain = (s: string) =>
  ` ${fold(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `

/** What a case is called: its title before the first colon, comma or dash, «Потолок-Арт» in «Потолок-Арт: потолки». */
export function caseName(title: string): string {
  return (title.split(/[:;,]|\s\p{Pd}\s/u)[0] ?? title).trim()
}

/**
 * Abbreviations and trade words of the portfolio that stand in a case's title but name no company: «Компания под NDA»,
 * «B2B-компания», «аудиобрендинг для HoReCa». Folded; a hyphenated word with one of them («B2B-компания») is no brand.
 */
const NOT_A_BRAND = new Set([
  'nda',
  'a/b',
  'b2b',
  'b2c',
  'c2c',
  'b2g',
  'crm',
  'erp',
  'cms',
  'saas',
  'seo',
  'smm',
  'sem',
  'ppc',
  'cpa',
  'cpc',
  'cpl',
  'roi',
  'kpi',
  'ctr',
  'it',
  'hr',
  'pr',
  'ui',
  'ux',
  'api',
  'pwa',
  'sms',
  'mvp',
  'gtm',
  'jtbd',
  'ai',
  'horeca',
  'ecommerce',
  'e-commerce',
  'fintech',
  'fitnesstech',
  'edtech',
  'proptech',
  'online',
  'offline',
  'digital',
])

/** English words that say what a company is, after its name: «Sotnikova Agency», «Akopov Team», «Wayforce Gym». */
const GENERIC_TAIL = new Set([
  'company',
  'team',
  'agency',
  'group',
  'gym',
  'club',
  'studio',
  'shop',
  'store',
  'school',
  'lab',
  'labs',
])

/**
 * A name of a case that a text can tell it by: one word (or one quoted phrase, or a whole Latin name) of its title.
 * `capital` is set for a Cyrillic word that is a name only because it is capitalized after the first word («Стальной
 * Каркас», «МИО»): then the text must write it with a capital too, or «стальной каркас» of an order would name the case.
 */
type Brand = { tokens: string[]; capital: boolean }

const TOKEN = /[\p{L}\p{N}]+(?:[./'’-][\p{L}\p{N}]+)*/gu
const tokensOf = (s: string): string[] => s.replace(/ё/g, 'е').replace(/Ё/g, 'Е').match(TOKEN) ?? []
const trimWord = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
const isLatin = (w: string) => /[A-Za-z0-9]/.test(w)
/** A word without its ending, so «Грибатории» finds «Грибатория». */
const stem = (w: string) => (w.length >= 4 ? w.slice(0, Math.max(3, w.length - 2)) : w)

/** Whether a word of a title part is a brand word; `k` is its place in the part and `n` the number of words in it. */
function isBrandWord(w: string, k: number, n: number): boolean {
  if (w.length < 2) return false
  const low = fold(w)
  if (low.split('-').some((part) => NOT_A_BRAND.has(part)) || NOT_A_BRAND.has(low)) return false
  if (GENERIC_TAIL.has(low) || /^(?:19|20)\d{2}$/.test(w)) return false
  // «Потолок-Арт», «Окна-Мастер»: every part capitalized. «Боулинг-клуб», «Онлайн-курс» say what the client is.
  if (w.includes('-') && /\p{L}-\p{L}/u.test(w))
    return w.split('-').every((part) => /^[\p{Lu}\d]/u.test(part))
  if (isLatin(w)) return true
  // A single word is the name itself; after the first word only a capitalized one is.
  return n === 1 || (k > 0 && /^\p{Lu}/u.test(w))
}

/**
 * The brand names in the title of a case, from the part of it before the first colon, comma or dash, cut at « / »
 * («Akopov Team / LevTrain» has two): the Latin, hyphenated, numbered or capitalized words that are a name and not a
 * description, and a quoted name. «Сеть стоматологий», «Компания под NDA», «Боулинг-клуб» have none: they say what the
 * client is, the code cannot know the name behind them, and such a case is told by its id only.
 */
export function brandNames(title: string): Brand[] {
  const brands: Brand[] = []
  for (const part of caseName(title).split(/\s+\/\s+/)) {
    const quoted = [...part.matchAll(/[«"“]([^»"”]+)[»"”]/gu)].map((m) => m[1] ?? '')
    for (const q of quoted)
      if (tokensOf(q).length > 0) brands.push({ tokens: tokensOf(q), capital: !isLatin(q) })
    const words = part
      .replace(/[«"“][^»"”]+[»"”]/gu, ' ')
      .split(/\s+/)
      .map(trimWord)
      .filter(Boolean)
    let found = 0
    const size = words.length + quoted.length
    words.forEach((w, k) => {
      if (!isBrandWord(w, k, size)) return
      found++
      const cyrillicAfterFirst = !isLatin(w) && !w.includes('-') && words.length > 1
      brands.push({ tokens: [w], capital: cyrillicAfterFirst })
    })
    // A Latin name made only of abbreviations and trade words, «A/B Company», is told as a whole.
    if (quoted.length === 0 && found === 0 && words.length >= 2 && words.every(isLatin))
      brands.push({ tokens: words, capital: false })
  }
  return brands
}

/** Whether one word of a text is the word of a brand (Latin as written in any letter case, Cyrillic with any ending). */
function sameWord(t: string, b: string, capital: boolean): boolean {
  if (isLatin(b)) return fold(t) === fold(b)
  if (capital && !/^\p{Lu}/u.test(t)) return false
  return fold(t).startsWith(fold(stem(b.replace(/ё/g, 'е'))))
}

/** Whether a text tells a brand name: its words stand in the text one after another. */
function namesBrand(text: string, brand: Brand): boolean {
  const have = tokensOf(text)
  const want = brand.tokens
  for (let k = 0; k + want.length <= have.length; k++)
    if (want.every((w, j) => sameWord(have[k + j] ?? '', tokensOf(w)[0] ?? w, brand.capital)))
      return true
  return false
}

/**
 * Whether a text tells a case by its name: one of the brand names of its title stands in the text. A title that says
 * what the client is («Музыкальная школа МИО» has only «МИО», «Компания из сферы строительства» has no name) is not
 * matched by its descriptive words, or an order for a music school would name the case; such a case is told by its id.
 */
export function namesCase(text: string, title: string): boolean {
  return brandNames(title).some((b) => namesBrand(text, b))
}

/** The brand name of a case that a text tells, as written in the title, or null. */
function namesCompany(text: string, title: string): string | null {
  const hit = brandNames(title).find((b) => namesBrand(text, b))
  return hit ? hit.tokens.join(' ') : null
}

export function caseIssues(
  i: CheckInput,
  text: string,
  /** The numbers of a text as keys, from codeChecks (a case's closed numbers are looked for among them). */
  numberKeys: (s: string) => Set<string>,
): CheckIssue[] {
  const issues: CheckIssue[] = []
  const folded = fold(text)
  const flat = plain(text)

  for (const phrase of CASE_AD_PHRASES)
    if (flat.includes(plain(phrase))) {
      issues.push({ id: 'case.ad', detail: `реклама вместо живого слова: «${phrase}»` })
      break
    }
  const link = CASE_LINK.exec(text)
  if (link)
    issues.push({
      id: 'case.link',
      detail: `ссылка в тексте: «${link[0]}», ссылку ставит программа`,
    })

  const c = i.cases
  if (!c) return issues
  const choice = c.choice
  const chosen = choice?.case_id ? (c.offered.find((o) => o.id === choice.case_id) ?? null) : null
  const toldIds = new Set(c.told.map((t) => t.id))

  // A case that is not in this turn's list: an id from nowhere, or a story of a project with no case behind it.
  if (choice?.case_id && !chosen && !toldIds.has(choice.case_id))
    issues.push({ id: 'case.unknown', detail: `кейс ${choice.case_id} не из кейсов этого хода` })
  else if (!choice?.case_id) {
    const claim = CASE_CLAIM.exec(folded)
    if (claim)
      issues.push({
        id: 'case.unknown',
        detail: `в тексте рассказ о проекте, а кейс не выбран: «${claim[0]}»`,
      })
  }

  if (choice?.case_id && !choice.moment)
    issues.push({ id: 'case.no_moment', detail: 'кейс назван без момента для него' })

  // Told before: the id again, its name in the text, or the chosen case's name in what our side wrote.
  const repeated =
    (choice?.case_id && toldIds.has(choice.case_id)) ||
    c.told.some((t) => namesCase(text, t.title)) ||
    (chosen !== null && i.ourPrevious.some((m) => namesCase(m, chosen.title)))
  if (repeated) issues.push({ id: 'case.repeat', detail: 'этот кейс уже звучал в чате' })

  // More than one case of the library in one text.
  const named = c.offered.filter((o) => namesCase(text, o.title))
  const mentioned = new Set([...named.map((o) => o.id), ...(chosen ? [chosen.id] : [])])
  if (mentioned.size > 1) issues.push({ id: 'case.many', detail: 'в тексте больше одного кейса' })

  // What the show rules close: numbers of the result and the company's name.
  const textNumbers = numberKeys(text)
  for (const o of [
    ...new Map([...named, ...(chosen ? [chosen] : [])].map((h) => [h.id, h])).values(),
  ]) {
    if (!o.numbersOpen) {
      const closed = [...numberKeys(`${o.summary}\n${o.result ?? ''}`)].find((k) =>
        textNumbers.has(k),
      )
      if (closed)
        issues.push({
          id: 'case.closed',
          detail: `цифры кейса ${o.id} показывать нельзя: ${closed}`,
        })
    }
    if (!o.nameOpen) {
      const name = namesCompany(text, o.title)
      if (name)
        issues.push({
          id: 'case.closed',
          detail: `название компании кейса ${o.id} называть нельзя: «${name}»`,
        })
    }
  }
  return issues
}
