import type { MindFrontmatter } from '@sara/shared'
import type { CaseHit, MindHit } from '../conversation/types'
import { markdownSections } from './loader'

/**
 * The cases of Hance in the mind (Task B6): knowledge records tagged «кейс». A case reaches a reply only through the
 * case search, never as a fact, so the index marks it and the fact search leaves it out.
 */

/** The tag that makes a knowledge record a case, in any letter case. */
export const CASE_TAG = 'кейс'

/** The marker lexeme the indexer adds to the vector of a case; no word of a client query can spell it. */
export const CASE_LEXEME = 'saracasetag'

/** The section of a case that says what may be shown to a client. */
export const SHOW_RULES_SECTION = 'Как показывать клиенту'

/** True for a knowledge record with the tag «кейс» (the other types are never cases). */
export function isCaseRecord(front: Pick<MindFrontmatter, 'type' | 'tags'>): boolean {
  return (
    front.type === 'knowledge' &&
    (front.tags ?? []).some((t) => t.trim().toLowerCase() === CASE_TAG)
  )
}

/**
 * What the case search reads in a case record (FR-MIND-2): the title and tags, the gist (the first paragraph), and the
 * sections that say what was done, where, in what role and with what result. The rules of showing, the state of the
 * description and the materials are about how to tell the case, not about the work, so they stay out of the index:
 * «Как показывать клиенту» and «Состояние описания» are full of the words a client asks with («примеры», «работ»).
 */
export const CASE_SEARCH_SECTIONS = ['Что делали', 'Где', 'Роль и масштаб', 'Результат']

/** The stock text of an empty field in a case record: it says nothing about the work and is not indexed. */
const EMPTY_FIELD = /^пока не зафиксировано/i

/** The three texts of a case the index weighs: the head (title, tags), the gist, the sections of the work. */
export function caseSearchText(
  title: string,
  tags: string[],
  body: string,
): { head: string; summary: string; details: string } {
  const sections = markdownSections(body)
  const details = CASE_SEARCH_SECTIONS.map((name) => sections[name] ?? '')
    .filter((text) => text.length > 0 && !EMPTY_FIELD.test(text))
    .join('\n')
  return {
    head: [title, ...tags.filter((t) => t.trim().toLowerCase() !== CASE_TAG)].join(' '),
    summary: firstParagraph(body),
    details,
  }
}

/** The first paragraph of a body, before any section: the gist of the case. */
export function firstParagraph(body: string): string {
  const intro = body.split(/^## /m)[0] ?? ''
  return (intro.trim().split(/\n\s*\n/)[0] ?? '').trim()
}

/** The «- » items of a section; an indented line under an item continues it. */
export function listItems(section: string): string[] {
  const items: string[] = []
  for (const line of section.split('\n')) {
    if (line.startsWith('- ')) items.push(line.slice(2).trim())
    else if (/^\s+\S/.test(line) && items.length > 0)
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`
  }
  return items.filter((i) => i.length > 0)
}

/** The rules cut into short clauses, so «компанию не называть, цифры можно» is read as two statements. */
const clauses = (rules: string[]): string[] =>
  rules
    .flatMap((r) => r.split(/[.!?;:,]+/))
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0)

/** The verbs of telling a fact to a client. */
const TELL = '(?:называть|раскрывать|разглашать|упоминать|указывать|озвучивать)'
/** «не называть», «нельзя называть», «называть нельзя», «не называем», «не раскрывается»: a ban on telling something. */
const BAN = new RegExp(
  `(?:(?<!\\p{L})не|нельзя)\\s+${TELL}|${TELL}\\s+нельзя|(?<!\\p{L})не\\s+(?:называ|раскрыва|разглаш|упомина|указыва)(?:ем|йте|ется|ют)`,
  'u',
)
/** «можно называть», «называть можно»: an allow to tell something. */
const ALLOW = new RegExp(`можно\\s+${TELL}|${TELL}\\s+можно`, 'u')
/** A clause that hides the name without a verb of telling: «Без названия компании», «Название скрыть», «Анонимно». */
const HIDES_NAME = /без\s+назван|скры(?:ть|вать|ваем|йте|т[оаы]?)|анонимн/u
const NDA = /(?<![a-z])nda(?![a-z])/
const COMPANY = /компани|названи|бренд|имя|имен/u

/** True for a clause that bans telling the name of the company (a ban that is only about the numbers does not). */
const bansName = (c: string): boolean =>
  NDA.test(c) ||
  HIDES_NAME.test(c) ||
  (BAN.test(c) && (!c.includes('цифр') || COMPANY.test(c))) ||
  (c.includes('нельзя') && COMPANY.test(c))

/** True for a clause that allows telling the name of the company, in words about the company itself. */
const allowsName = (c: string): boolean => ALLOW.test(c) && COMPANY.test(c)

/** True for a clause that bans the numbers of the result. */
const bansNumbers = (c: string): boolean => BAN.test(c) || c.includes('нельзя')

/**
 * What the show rules of a case allow, read from their words. Both are closed unless a clause allows them and none
 * forbids them: the company is open only on an explicit allow («Компанию можно называть») and stays closed on a ban
 * (NDA, «не называть», «называть нельзя», «без названия», «скрыть», «анонимно») or on silence; the numbers are open only
 * on an explicit allow («Цифры можно называть») and no ban on them. A case with no rules shows neither: mind:check does
 * not let it into the mind, and here it is closed anyway.
 */
export function readShowRules(rules: string[]): { nameOpen: boolean; numbersOpen: boolean } {
  if (rules.length === 0) return { nameOpen: false, numbersOpen: false }
  const all = clauses(rules)
  const nameOpen = all.some(allowsName) && !all.some(bansName)
  const numbers = all.filter((c) => c.includes('цифр'))
  const numbersOpen = numbers.some((c) => ALLOW.test(c)) && !numbers.some(bansNumbers)
  return { nameOpen, numbersOpen }
}

/**
 * True when the rules say something about the company name: an allow or a ban. A case whose rules are silent about it
 * (only the numbers, a remark about the kind of case) is unclear, and mind:check does not let it into the mind.
 */
export function nameRuleStated(rules: string[]): boolean {
  const all = clauses(rules)
  return all.some(allowsName) || all.some(bansName)
}

/** A hit of the case search with what a turn needs from the record: the gist, the result, the rules of showing. */
export function toCaseHit(hit: MindHit): CaseHit {
  const sections = markdownSections(hit.body)
  const showRules = listItems(sections[SHOW_RULES_SECTION] ?? '')
  return {
    ...hit,
    summary: firstParagraph(hit.body),
    result: sections.Результат || null,
    showRules,
    ...readShowRules(showRules),
  }
}
