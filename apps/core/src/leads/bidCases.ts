import { publicLink } from '../conversation/caseLink'
import { caseIssues } from '../conversation/check/caseChecks'
import { numberKeys } from '../conversation/check/codeChecks'
import { caseQuery } from '../conversation/engine'
import { formatCase } from '../conversation/prompt'
import type { CaseHit, MindSearch } from '../conversation/types'
import type { DraftSource } from './draft'

/**
 * Cases of Hance in a bid (Boris, 28.10.2026): «искать соответствие заказа нашим имеющимся кейсам». The Analyst reads the
 * cases of the mind that fit the order and may tell one of them in the text; the code checks what it told.
 */

/** The most cases of the mind the Analyst reads for one bid, as in a conversation turn. */
const BID_CASES = 3

/**
 * The cases of the mind that fit the order, by its title and text. Without the case search, or when it fails, there
 * are none: the bid is written as it was.
 */
export async function casesForBid(
  mind: Pick<MindSearch, 'cases'> | undefined,
  o: Pick<DraftSource, 'title' | 'text'>,
  scope: string,
): Promise<CaseHit[]> {
  if (!mind?.cases) return []
  try {
    const text = caseQuery('', {
      title: o.title,
      text: o.text,
      category: '',
      city: '',
      budgetText: null,
    })
    return await mind.cases({ text, scope, limit: BID_CASES })
  } catch (e) {
    console.error('bid case search failed', e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * The cases as the Analyst reads them, with the rules of showing each one and whether it has a public link for the
 * series (the program puts the link in, the model never sees it); nothing when there are none.
 */
export function bidCasesText(cases: CaseHit[], blocked: readonly string[] = []): string {
  if (cases.length === 0) return ''
  return [
    'Кейсы Hance, которые могут подойти к заказу (разделы «Кейс в отклике» и «Серия» твоих правил):',
    ...cases.map(
      (c) =>
        `${formatCase(c)}\nПубличная ссылка: ${publicLink(c, blocked) ? 'есть, её можно показать в серии' : 'нет'}`,
    ),
  ].join('\n\n')
}

/** The one case the answer chose among those offered, or null (an id from elsewhere is not a choice). */
export function chosenCase(cases: CaseHit[], ids: readonly string[] | undefined): CaseHit | null {
  const id = (ids ?? []).find((i) => cases.some((c) => c.id === i))
  return id ? (cases.find((c) => c.id === id) ?? null) : null
}

/**
 * What is wrong with the cases in a bid text, by the checks of a conversation reply: a story with no case behind
 * it, a case's closed numbers or company, more than one case, an ad phrase or a link. Empty when all is well.
 */
export function bidCaseProblems(
  text: string,
  cases: CaseHit[],
  ids: readonly string[] | undefined,
): string[] {
  const chosen = chosenCase(cases, ids)
  // An id the list does not have is no choice at all: its story is checked as one with no case behind it.
  const caseId = chosen?.id ?? null
  return caseIssues(
    {
      text,
      move: 'reply',
      factIds: [],
      recalledIds: [],
      knowledgeTexts: {},
      newDay: false,
      clientTurnText: '',
      ourPrevious: [],
      bannedPhrases: [],
      cases: {
        offered: cases,
        told: [],
        choice: caseId ? { moment: 'same_problem', case_id: caseId, why: null } : null,
      },
    },
    text,
    numberKeys,
  ).map((i) => i.detail)
}
