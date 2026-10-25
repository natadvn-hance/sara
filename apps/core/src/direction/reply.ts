import { BID_CHARS_MAX, type DirectionCase, type ReplyFormat } from '@sara/shared'

/** What a direction tells the Analyst about its bids (FR-LEAD-6): the format and the case library. */
export type ReplyProfile = { reply_format: ReplyFormat | null; cases: DirectionCase[] }

const caseLine = (c: DirectionCase) =>
  `Похожая работа: ${c.title.replace(/[\u2013\u2014]/g, '-')}, ${c.url}`
/** The blank line between the text and the cases. */
const GAP = 2

/** The cases a bid may carry: only when the format allows some, and only with a link that is https. */
const usable = (p: ReplyProfile): DirectionCase[] =>
  p.reply_format && p.reply_format.max_cases > 0
    ? p.cases.filter((c) => c.url.startsWith('https://'))
    : []

/** The longest a whole bid may be: the form's 500 characters, or the format's own smaller number. */
export const bidCeiling = (p: ReplyProfile): number =>
  Math.min(BID_CHARS_MAX, p.reply_format?.max_chars ?? BID_CHARS_MAX)

/**
 * What the Analyst reads of the direction besides the order. Nothing when the direction has neither a format nor
 * cases, so the input stays what it was. The links are never here: the model names a case by its id, the program
 * puts the link in.
 */
export function analystProfileText(p: ReplyProfile): string {
  const lines: string[] = []
  const f = p.reply_format
  if (f) {
    lines.push('Формат отклика этого направления (главнее общих правил о построении текста):')
    lines.push('Части по порядку (приветствие ставит программа, его не пиши):')
    for (const [i, part] of f.parts.entries()) lines.push(`${i + 1}. ${part.title}: ${part.hint}`)
    if (f.tone.length > 0) lines.push(`Тон: ${f.tone.join('; ')}`)
    if (f.examples.length > 0) {
      lines.push('Образцы откликов, которые Борис одобрил (только тело, без приветствия):')
      for (const e of f.examples) lines.push(`- ${e}`)
    }
  }
  const cases = usable(p)
  if (f && cases.length > 0) {
    lines.push('')
    lines.push(
      `Кейсы направления. Можно показать не больше ${f.max_cases}, только если кейс подходит заказу по правилу. Ссылки подставит программа, ты называешь только id в поле case_ids.`,
    )
    for (const c of cases) {
      const when = c.never_when ? ` Не показывай, когда: ${c.never_when}.` : ''
      const tags = c.tags.length > 0 ? ` Теги: ${c.tags.join(', ')}.` : ''
      lines.push(
        `- ${c.id}: ${c.title}. ${c.summary} Показывай, когда: ${c.show_when}.${when}${tags}`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * The room kept from the text for the cases: the blank line and the longest cases that may go in, one per line. The
 * model is told a shorter limit by this much, so a case does not push out the meaning of the bid.
 */
export function caseReserve(p: ReplyProfile): number {
  const cases = usable(p)
  const n = p.reply_format?.max_cases ?? 0
  if (cases.length === 0 || n === 0) return 0
  const longest = cases
    .map((c) => caseLine(c).length)
    .sort((a, b) => b - a)
    .slice(0, n)
  return GAP + longest.reduce((s, l) => s + l, 0) + (longest.length - 1)
}

/**
 * The cases the model asked for, as the program puts them in: only ids the library has, once each, at most as many
 * as the format allows, after a blank line, and only as many as keep the whole bid within its ceiling. The model's
 * own text is never cut; a case that does not fit is left out, the last ones first.
 */
export function placeCases(
  text: string,
  p: ReplyProfile,
  ids: readonly string[],
): { text: string; shown: string[] } {
  const library = new Map(usable(p).map((c) => [c.id, c]))
  const max = p.reply_format?.max_cases ?? 0
  const picked: DirectionCase[] = []
  for (const id of ids) {
    const c = library.get(id)
    if (c && !picked.includes(c) && picked.length < max) picked.push(c)
  }
  while (picked.length > 0) {
    const out = `${text}\n\n${picked.map(caseLine).join('\n')}`
    if (out.length <= bidCeiling(p)) return { text: out, shown: picked.map((c) => c.id) }
    picked.pop()
  }
  return { text, shown: [] }
}
