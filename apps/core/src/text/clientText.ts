/**
 * The text a client reads (M4 part V, Boris's 15 voice decisions of 26.10): one module for the bids of the Analyst
 * and for the replies of the Interlocutor. Pure functions only: nothing here reads a clock, a database or a model.
 * Long and medium dashes are written below as escapes, never as the characters (CI forbids the long one in files).
 */

import { firstName } from '../leads/clientName'

/**
 * Words that open a message before a comma and are not a name (folded): «Понимаю, добрый день у вас был» is no
 * «name, greeting». The same list is `NOT_NAMES` of the conversation module (conversation/check/phrases); it is kept
 * here so this module needs nothing from it, and one of the two may import the other when both are on one branch.
 */
const NOT_NAMES = new Set([
  'здравствуйте',
  'здравствуй',
  'привет',
  'приветствую',
  'добрый',
  'доброе',
  'доброго',
  'добрая',
  'доброй',
  'спасибо',
  'благодарю',
  'хорошо',
  'отлично',
  'конечно',
  'да',
  'нет',
  'итак',
  'извините',
  'простите',
  'понимаю',
  'понял',
  'поняла',
  'ясно',
  'понятно',
  'видимо',
  'кстати',
  'ладно',
  'тогда',
  'сейчас',
  'смотрите',
  'скажите',
  'подскажите',
  'вижу',
  'согласна',
  'согласен',
  'договорились',
  'отвечу',
  'напишу',
  'уточню',
  'сделаем',
  'посмотрим',
  'обсудим',
  'давайте',
  'верно',
  'точно',
  'безусловно',
  'разумеется',
  'жаль',
  'пожалуйста',
  'еще',
])

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
/** The private-use characters that stand in for the protected spans (built from a string: a plain literal here would hold them unseen). */
const SLOT = /[\ue100-\uf8ff]/g
/** The hyphen and the non-breaking hyphen of a word processor: plain hyphens to the rules below. */
const TYPOGRAPHIC_HYPHEN = /[\u2010\u2011]/g

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
    .replace(TYPOGRAPHIC_HYPHEN, '-')
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
    .replace(SLOT, (c) => saved[c.charCodeAt(0) - SLOT_BASE] ?? c)
}

// ---------------------------------------------------------------------------------------------------------------
// Rule 5: the greeting by Moscow time

export type PartOfDay = 'morning' | 'day' | 'evening'

// Hour only, 0 to 23 (`h23`, so midnight is 0 and never 24). The zone is asked for by name and nothing here knows
// its offset or its summer time.
const MOSCOW_HOUR = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Moscow',
  hour: 'numeric',
  hourCycle: 'h23',
})

/** Before 12:00 Moscow time the morning, from 12:00 to 17:59 the day, from 18:00 the evening (a night is a morning). */
export function moscowPartOfDay(now: Date): PartOfDay {
  const hour = Number(MOSCOW_HOUR.formatToParts(now).find((p) => p.type === 'hour')?.value)
  return hour < 12 ? 'morning' : hour < 18 ? 'day' : 'evening'
}

const NOMINATIVE: Record<PartOfDay, string> = {
  morning: 'доброе утро',
  day: 'добрый день',
  evening: 'добрый вечер',
}

/** The name Sara may call a client by: the first one, capitalized; none for an empty name or Profi.ru's stand-in. */
function nameOf(name: string | null): string | null {
  const first = name ? firstName(name) : null
  return first ? `${first.charAt(0).toUpperCase()}${first.slice(1)}` : null
}

/**
 * The greeting of a message built at send time: «Имя, добрый день!» with a name, «Добрый день!» without one, by the
 * hour in Moscow («Доброе утро», «Добрый день», «Добрый вечер»). The model never writes it.
 */
export function greetingFor(now: Date, name: string | null): string {
  const word = NOMINATIVE[moscowPartOfDay(now)]
  const known = nameOf(name)
  return known ? `${known}, ${word}!` : `${word.charAt(0).toUpperCase()}${word.slice(1)}!`
}

// A name before or after the greeting: a capitalized word, or the tag of ADR-016 the model is given.
const GREETING_NAME = String.raw`(\p{Lu}[\p{L}-]*|\[имя \d+\])`
const GREETING_NOM = String.raw`([Дд]обр(?:ое\s+утро|ый\s+день|ый\s+вечер))`
const GREETING_GEN = String.raw`([Дд]оброго\s+(?:дня|утра|вечера))`
const GREETING_END = String.raw`\s*[!.]?$`
const GREETING_FORMS = [
  // «Анна, добрый день!»
  new RegExp(String.raw`^${GREETING_NAME},\s*${GREETING_NOM}${GREETING_END}`, 'u'),
  // «Добрый день!»
  new RegExp(`^${GREETING_NOM}${GREETING_END}`, 'u'),
  // «Доброго дня, Анна!» and «Доброго дня!»
  new RegExp(String.raw`^${GREETING_GEN}(?:,\s*${GREETING_NAME})?${GREETING_END}`, 'u'),
]

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

/** The part of the day a text greets for when the whole text is one greeting in an allowed form, else null. */
function greetingPart(text: string): PartOfDay | null {
  const t = text.trim()
  for (const form of GREETING_FORMS) {
    const groups = form.exec(t)?.slice(1)
    if (!groups) continue
    const word = fold(groups.find((g) => g !== undefined && /^доб/iu.test(g)) ?? '')
    const name = groups.find((g) => g !== undefined && !/^доб/iu.test(g))
    // «Понимаю, добрый день!» opens with a word that is no name.
    if (name && NOT_NAMES.has(fold(name))) return null
    return word.includes('утр') ? 'morning' : word.includes('веч') ? 'evening' : 'day'
  }
  return null
}

/**
 * Whether a text is one greeting in a form Boris allows: «Добрый день!», «Анна, доброе утро!», «Доброго дня, Анна!».
 * Not «Здравствуйте!», not «Добрый день, Анна!» (the name goes before the nominative and after the genitive).
 * With `now` the part of the day must also be the one of that moment in Moscow.
 */
export function isGreetingForm(text: string, now?: Date): boolean {
  const part = greetingPart(text)
  return part !== null && (now === undefined || part === moscowPartOfDay(now))
}

/** The greeting a text opens with, when its first sentence is one in an allowed form (else null). */
export function leadingGreeting(text: string): string | null {
  const first = /^[^\n!.]*[!.]?/.exec(text.trimStart())?.[0].trim() ?? ''
  return first && isGreetingForm(first) ? first : null
}
