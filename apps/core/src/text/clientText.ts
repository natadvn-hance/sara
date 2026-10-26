/**
 * The text a client reads (M4 part V, Boris's 15 voice decisions of 26.10): one module for the bids of the Analyst
 * and for the replies of the Interlocutor. Pure functions only: nothing here reads a clock, a database or a model.
 * Long and medium dashes are written below as escapes, never as the characters (CI forbids the long one in files).
 */

// ---------------------------------------------------------------------------------------------------------------
// Rules 3, 4, 15: dashes, the final period, paragraphs

/** Dashes: figure, medium, long and the horizontal bar. */
const DASH = '\\u2012-\\u2015'
/** Spaces that may stand around a dash. A non-breaking space is one of them: «50 000 - 60 000». */
const GAP = '[ \\t\\u00a0]'

/** One emoji sign or the glue of a sequence (joiner, variation selector, skin tone). */
const EMOJI_PART = '[\\p{Extended_Pictographic}\\u200d\\ufe0f\\u{1F3FB}-\\u{1F3FF}]'
const EMOJI_TAIL = new RegExp(`(?:\\s|${EMOJI_PART})*$`, 'u')

/**
 * What must come out of the dash and hyphen passes untouched: links, bare domains and addresses. A hyphen in a
 * domain is part of the domain. Each span is swapped for one private-use character and put back at the end.
 */
const PROTECTED = new RegExp(
  [
    String.raw`https?:\/\/\S*[^\s.,;:!?)»"']`,
    String.raw`www\.\S*[^\s.,;:!?)»"']`,
    String.raw`[\p{L}\d._%+-]+@[\p{L}\d.-]+\.\p{L}{2,}`,
    String.raw`(?<![\p{L}\d@.-])[\p{L}\d][\p{L}\d-]*(?:\.[\p{L}\d-]+)*\.(?:ru|рф|com|net|org|io|app|su|pro|dev|me|co|site|online|biz|info)(?![\p{L}\d])`,
  ].join('|'),
  'giu',
)
const SLOT_BASE = 0xe100

/** Words that may stand in lower case inside a place name: «Ростов-на-Дону», «Ле-Ман», «Бад-Кройцнах». */
const NAME_LINKS = new Set([
  'на',
  'под',
  'над',
  'при',
  'де',
  'ла',
  'ле',
  'ди',
  'дю',
  'ван',
  'фон',
  'дер',
])

/**
 * Whether the hyphens of a word stay (rule 3). They stay in names and brands: a word with a Latin letter («Wi-Fi»,
 * «A-Store», «SEO-продвижение»), with a digit («2-3», «10-15%», phone numbers, «B2B-сегмент», «1С-Битрикс»), or one
 * whose parts are all capitalized («Санкт-Петербург», «Анна-Мария») or capitalized with a link word in lower case
 * («Ростов-на-Дону»). In «что-то», «все-таки», «по-русски», «Что-то» (a capital at the start of a sentence) the
 * hyphen goes. When in doubt a hyphen stays: a hurt name costs more than a hyphen kept.
 */
function keepsHyphens(word: string): boolean {
  if (/[\d]|[A-Za-z]/.test(word)) return true
  const parts = word.split('-')
  const capital = (p: string) => /^\p{Lu}/u.test(p)
  if (parts.every(capital)) return true
  const [head, ...rest] = parts
  return (
    capital(head ?? '') && rest.every((p) => capital(p) || NAME_LINKS.has(p)) && rest.some(capital)
  )
}

/** A dash with the spaces around it, a spaced or line-leading hyphen: all of them are the same dash to remove. */
const DASH_SIGN = new RegExp(
  `${GAP}*[${DASH}]+${GAP}*|${GAP}+-+(?=${GAP}|$)${GAP}*|^-+${GAP}+`,
  'gmu',
)
/** A dash between two numbers is a range, and a range is written with a short hyphen: «2-3 недели», «10-15%». */
const DASH_RANGE = new RegExp(`(?<=\\d%?)(?:${GAP}*[${DASH}]+${GAP}*|${GAP}+-${GAP}+)(?=\\d)`, 'gu')
const WORD_WITH_HYPHEN = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+/gu

function removeDashes(text: string): string {
  const ranged = text.replace(DASH_RANGE, '-')
  const gone = ranged.replace(DASH_SIGN, (m, offset: number, whole: string) => {
    const before = whole[offset - 1]
    const after = whole[offset + m.length]
    // At the start or the end of a line, before a sign of punctuation or after an opening bracket the dash leaves
    // nothing behind; between words it leaves one space.
    if (before === undefined || before === '\n' || before === '(' || before === '«') return ''
    if (after === undefined || after === '\n' || /[,.;:!?)»]/.test(after)) return ''
    return ' '
  })
  return gone.replace(WORD_WITH_HYPHEN, (word) =>
    keepsHyphens(word) ? word : word.replaceAll('-', ' '),
  )
}

/** The line without the period that closes it. «Хм..» and «Хм...» keep theirs, an emoji at the end stays. */
function dropFinalPeriod(line: string): string {
  const tail = EMOJI_TAIL.exec(line)?.[0] ?? ''
  const head = line.slice(0, line.length - tail.length)
  if (!/(?<![.…])\.$/.test(head)) return line
  const cut = head.slice(0, -1)
  return tail && !/^\s/.test(tail) ? `${cut} ${tail}` : `${cut}${tail}`
}

/**
 * The text of a client message the way Boris writes it (rules 3, 4, 15): no long or medium dash, no hyphen in
 * common words («что то»), no period at the end of a paragraph or a line, one empty line between paragraphs,
 * trimmed spaces. A hyphen stays in names, brands, numbers and links; «?», «!», «…» and «)» at the end stay;
 * emoji are not touched. A single line break inside a paragraph stays, and the line before it loses its final
 * period like a paragraph does. Applying it twice gives the same text.
 */
export function fixClientText(text: string): string {
  const saved: string[] = []
  const hidden = text
    .replace(/\r\n?/g, '\n')
    .replace(/[‐‑]/g, '-')
    .replace(PROTECTED, (m) => {
      saved.push(m)
      return String.fromCharCode(SLOT_BASE + saved.length - 1)
    })
  const lines = removeDashes(hidden)
    .split('\n')
    .map((line) => dropFinalPeriod(line.replace(/[ \t]+/g, ' ').trim()).trim())
  const paragraphs: string[][] = [[]]
  for (const line of lines) {
    if (line) paragraphs[paragraphs.length - 1]?.push(line)
    else if (paragraphs[paragraphs.length - 1]?.length) paragraphs.push([])
  }
  return paragraphs
    .filter((p) => p.length > 0)
    .map((p) => p.join('\n'))
    .join('\n\n')
    .replace(/[-]/g, (c) => saved[c.charCodeAt(0) - SLOT_BASE] ?? c)
}
