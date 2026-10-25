import type { CaseMoment } from '@sara/shared'
import type { CaseHit } from './types'

/**
 * The link of a case is put in the reply by the code, never by the model (cases in a conversation, section 4): only
 * when the record has a public link, its show rules allow it, the company is not closed, and the client asked for
 * examples (the moment is `asked` or `order_asks`). The records hold no links yet, so until they do, there is none.
 */

const URL_IN_BODY = /https?:\/\/[^\s<>()[\]«»"]+/gu
/** Working folders and tools of Boris's: a link there is not for a client (cases requirement, section 8). */
const NOT_PUBLIC =
  /(?:^|\.)(?:drive\.google\.com|docs\.google\.com|disk\.yandex\.\w+|yadi\.sk|dropbox\.com|notion\.so|notion\.site|figma\.com|miro\.com|trello\.com|t\.me|wa\.me)$/u

/** The moments at which a client has asked to see the work. */
const ASKED: readonly (CaseMoment | null)[] = ['asked', 'order_asks']

/** Whether the show rules let the link be given: a clause about the link that allows it and none that forbids it. */
function linkAllowed(rules: string[]): boolean {
  const clauses = rules
    .flatMap((r) => r.split(/[.!?;:,]+/))
    .map((c) => c.trim().toLowerCase().replace(/ё/g, 'е'))
    .filter((c) => c.includes('ссылк'))
  const forbids = (c: string) =>
    /(?<!\p{L})не\s+(?:называть|давать|показывать|указывать|присылать|отдавать|упоминать)|нельзя/u.test(
      c,
    )
  return clauses.some((c) => /можно/u.test(c)) && !clauses.some(forbids)
}

/** The public link of a case to put into a reply told at this moment, or null. */
export function caseLink(c: CaseHit, moment: CaseMoment | null): string | null {
  if (!ASKED.includes(moment) || !c.nameOpen || !linkAllowed(c.showRules)) return null
  for (const url of c.body.match(URL_IN_BODY) ?? []) {
    const clean = url.replace(/[.,;:!?]+$/u, '')
    try {
      if (!NOT_PUBLIC.test(new URL(clean).hostname)) return clean
    } catch {
      // Not a link after all.
    }
  }
  return null
}
