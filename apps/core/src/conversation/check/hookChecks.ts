import { samePage } from '../../gateway/claudeCli'
import type { CheckIssue } from '../types'

/**
 * No fact without a source (Boris, 07.11.2026, spec 2026-11-07-organic-pings). A ping may carry one fresh fact of the
 * client's market or niche, but only with the page it came from, and that page must be one the web search of this
 * very run gave back: a link the model wrote itself is no source. Words of a news item or a statistic with no such
 * page are taken as an invented fact. Both are `hook.unsourced` (S1): the ping is written again without news.
 */

export type Hook = { fact: string; source_url: string }

/** Words that state a fact of the world: a study, a statistic, a change by some amount, a law coming into force. */
const FACT_WORDS =
  /(?<!\p{L})(?:по\s+данным|исследовани\p{L}*|опрос\p{L}*|статистик\p{L}*|по\s+оценк\p{L}*|по\s+прогноз\p{L}*|сообща\p{L}*|аналитик\p{L}*|вырос(?:ла|ло|ли)?\s+на|выросл\p{L}*\s+на|снизил\p{L}*\s+на|сократил\p{L}*\s+на|упал\p{L}*\s+на|подорожал\p{L}*|подешевел\p{L}*|вступ\p{L}*\s+в\s+силу|в\s+20\d\d\s+году|недавно\s+(?:вышел|вышла|вышло|приняли|запустил\p{L}*))(?!\p{L})/u

/** Lower case with ё as е. */
const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

/** Whether the hook's page is one of the pages the run's tools gave back. */
export function hookSourced(hook: Hook | null, seen: readonly string[] | undefined): boolean {
  if (!hook) return false
  const page = samePage(hook.source_url)
  if (!page) return false
  return (seen ?? []).some((u) => samePage(u) === page)
}

/** The issues of a ping's fact: a hook with no page the search gave, or fact words with no hook that has one. */
export function hookIssues(i: {
  text: string
  hook: Hook | null
  seen: readonly string[] | undefined
}): CheckIssue[] {
  if (i.hook && !hookSourced(i.hook, i.seen))
    return [
      {
        id: 'hook.unsourced',
        detail: `у факта нет страницы, которую поиск правда дал: ${i.hook.source_url.slice(0, 120)}`,
      },
    ]
  if (i.hook) return []
  const m = FACT_WORDS.exec(fold(i.text))
  return m
    ? [{ id: 'hook.unsourced', detail: `похоже на факт или новость без источника: «${m[0]}»` }]
    : []
}
