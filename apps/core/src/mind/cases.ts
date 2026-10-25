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

/** «не называть», «нельзя называть», «не раскрывать»…: a ban on telling something. */
const BAN = /(?:(?<!\p{L})не|нельзя)\s+(?:называть|раскрывать|упоминать|указывать|озвучивать)/u
const ALLOW = /можно\s+называть/u
const NDA = /(?<![a-z])nda(?![a-z])/
const COMPANY = /компани|названи|бренд|имя/u

/**
 * What the show rules of a case allow, read from their words. The company stays open unless a clause closes it (NDA, or
 * a ban that is not only about the numbers); the numbers stay closed unless a clause allows them and none forbids them.
 * A case with no rules at all shows neither: mind:check does not let it into the mind, and here it is closed anyway.
 */
export function readShowRules(rules: string[]): { nameOpen: boolean; numbersOpen: boolean } {
  if (rules.length === 0) return { nameOpen: false, numbersOpen: false }
  const all = clauses(rules)
  const nameOpen = !all.some(
    (c) => NDA.test(c) || (BAN.test(c) && (!c.includes('цифр') || COMPANY.test(c))),
  )
  const numbers = all.filter((c) => c.includes('цифр'))
  const numbersOpen = numbers.some((c) => ALLOW.test(c)) && !numbers.some((c) => BAN.test(c))
  return { nameOpen, numbersOpen }
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
