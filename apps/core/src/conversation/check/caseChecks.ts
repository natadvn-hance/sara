import type { CaseHit, CheckInput, CheckIssue } from '../types'
import {
  CASE_AD_PHRASES,
  CASE_CLAIM_DID,
  CASE_CLAIM_INTRO,
  CASE_LINK,
  CASE_NEGATION,
  CASE_NEW_STORY,
  CASE_OUR_CLIENT,
  CASE_PAST_ANY,
} from './phrases'

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

/**
 * The text with the numbered part of a case's name blanked out (same length): «7.10» of «Боулинг-клуб 7.10» is the
 * club's name, not the 7th of October. The facts check reads dates and numbers in a reply, and it calls this on the
 * case the reply tells when the show rules let that case be named.
 */
export function maskCaseName(text: string, title: string): string {
  const numbered = new Set(
    brandNames(title)
      .flatMap((b) => b.tokens)
      .filter((t) => /\d/.test(t))
      .map(fold),
  )
  if (numbered.size === 0) return text
  return text.replace(TOKEN, (t) => (numbered.has(fold(t)) ? ' '.repeat(t.length) : t))
}

/** The brand name of a case that a text tells, as written in the title, or null. */
function namesCompany(text: string, title: string): string | null {
  const hit = brandNames(title).find((b) => namesBrand(text, b))
  return hit ? hit.tokens.join(' ') : null
}

/** A statement of a reply the claim check reads, as written and folded, with the number of the sentence it stands in. */
type Statement = { text: string; folded: string; sentence: number }

/**
 * The statements of a reply: sentences cut at «.», «!», «?», «;» and line breaks. A question to the client is
 * no statement of ours, but «Сделали похожее для стоматологии, хотите посмотреть?» has one in front of its question,
 * so a question keeps its comma parts except the last.
 */
function statements(text: string): Statement[] {
  const out: Statement[] = []
  let sentence = 0
  const add = (part: string) => out.push({ text: part, folded: fold(part), sentence })
  for (const m of text.matchAll(/[^.!?;\n]+[.!?;]*/g)) {
    const body = m[0].replace(/[.!?;]+$/, '').trim()
    if (!body) continue
    if (m[0].includes('?')) {
      const parts = body.split(/\s*,\s*/)
      parts.pop()
      for (const part of parts) if (part) add(part)
    } else add(body)
    sentence++
  }
  return out
}

/** What a claim is: the team's own work («did») or another client or project brought in («intro»). */
type Claim = { kind: 'did' | 'intro'; sentence: number; text: string }

/** Whether the match of a claim is negated: a «не», «нет» or «никогда» in it or just before it. */
const negated = (text: string, at: number, length: number): boolean =>
  CASE_NEGATION.test(text.slice(Math.max(0, at - 12), at + length))

/** The claims of a reply: where it tells of a project of ours (case.unknown unless a case of this turn is behind it). */
function claimsIn(text: string): Claim[] {
  const claims: Claim[] = []
  for (const st of statements(text)) {
    const found = (kind: Claim['kind'], re: RegExp) => {
      const m = re.exec(st.folded)
      if (m && !negated(st.folded, m.index, m[0].length))
        claims.push({ kind, sentence: st.sentence, text: st.text })
      return Boolean(m)
    }
    if (CASE_CLAIM_INTRO.some((re) => found('intro', re))) continue
    if (CASE_CLAIM_DID.some((re) => found('did', re))) continue
    // Our client and a verb of the past in one statement: «наш клиент начинал с одного канала».
    const ours = CASE_OUR_CLIENT.exec(st.folded)
    const past = CASE_PAST_ANY.exec(st.folded)
    if (ours && past && !negated(st.folded, ours.index, st.folded.length - ours.index))
      claims.push({ kind: 'intro', sentence: st.sentence, text: st.text })
  }
  return claims
}

/**
 * The claims that are not the story of the chosen case. The chosen case is told in the sentences that name its brand,
 * and when none does (a company under NDA is told by its description) in the first sentence of work; sentences of
 * work that go on right after it, with no new story in them, are the same story.
 */
function claimsOutside(claims: Claim[], chosen: CaseHit): Claim[] {
  const brands = brandNames(chosen.title)
  const named = claims.filter((c) => brands.some((b) => namesBrand(c.text, b)))
  const own = new Set(
    named.length > 0 ? named.map((c) => c.sentence) : claims.slice(0, 1).map((c) => c.sentence),
  )
  let last = Math.max(-1, ...own)
  const outside: Claim[] = []
  for (const c of claims) {
    if (own.has(c.sentence)) continue
    if (c.kind === 'did' && c.sentence === last + 1 && !CASE_NEW_STORY.test(fold(c.text))) {
      last = c.sentence
      continue
    }
    outside.push(c)
  }
  return outside
}

export function caseIssues(
  i: CheckInput,
  text: string,
  /** The numbers of a text as keys, from codeChecks (a case's closed numbers are looked for among them). */
  numberKeys: (s: string) => Set<string>,
): CheckIssue[] {
  const issues: CheckIssue[] = []
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
    const claim = claimsIn(text)[0]
    if (claim)
      issues.push({
        id: 'case.unknown',
        detail: `в тексте рассказ о проекте, а кейс не выбран: «${claim.text.slice(0, 80)}»`,
      })
  } else if (chosen) {
    // The chosen case is told once; a story of any other project beside it is as invented as one with no case.
    const other = claimsOutside(claimsIn(text), chosen)[0]
    if (other)
      issues.push({
        id: 'case.unknown',
        detail: `в тексте рассказ о другом проекте, кроме выбранного кейса: «${other.text.slice(0, 80)}»`,
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
  // A case of the list told by its name, though the answer chose none: it has no moment and no reason in the trace.
  if (!choice?.case_id && named.length > 0)
    issues.push({
      id: 'case.no_moment',
      detail: `кейс ${named[0]?.id} назван в тексте, а в ответе не выбран: повода для него нет`,
    })
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
