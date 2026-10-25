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

/** The words of a name that count when a text is searched for it (a hyphenated brand stays one word). */
const nameWords = (name: string) => fold(name).match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []
/** A word without its ending, so «сети стоматологий» finds «Сеть стоматологий». */
const stem = (w: string) => (w.length >= 4 ? w.slice(0, Math.max(3, w.length - 2)) : w)

/**
 * Whether a text tells a case by its name: every word of four letters or more of the name stands in the text with any
 * ending. A name of short words only is looked for as it is.
 */
export function namesCase(text: string, title: string): boolean {
  const words = nameWords(caseName(title))
  if (words.length === 0) return false
  const long = words.filter((w) => w.length >= 4)
  const need = long.length > 0 ? long : words
  const have = fold(text).match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []
  return need.every((w) => have.some((h) => h.startsWith(stem(w))))
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

/**
 * The words of a case's name that are a name and not a description: a word with a Latin letter or a digit, a hyphenated
 * word, or a capitalized word that is not the first, but never an abbreviation (NOT_A_BRAND). «Сеть стоматологий» has
 * none (it says what the client is), so a company under NDA may be told by it; the code cannot know a name the record
 * does not show.
 */
function brandWords(title: string): string[] {
  return caseName(title)
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(
      (w, k) =>
        w.length > 1 &&
        !fold(w)
          .split('-')
          .some((part) => NOT_A_BRAND.has(part)) &&
        (/[A-Za-z0-9]/.test(w) || w.includes('-') || (k > 0 && /^\p{Lu}/u.test(w))),
    )
}

/** Whether a text names the company of a case by one of its brand words (Latin ones in any letter case). */
function namesCompany(text: string, title: string): string | null {
  for (const w of brandWords(title)) {
    const latin = /[A-Za-z]/.test(w)
    if (latin ? fold(text).includes(fold(w)) : text.includes(w)) return w
  }
  return null
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
