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
 * The names and brands whose hyphen is theirs (rule 3), written whole and in the nominative; a case form («Нью-Йорка»)
 * and a lower-case spelling match as well. Add a name here when Boris says its hyphen must stay and nothing below
 * (a Latin-only word, a number, parts that are all capitalized) already keeps it. A name with no hyphen («1С:Франчайзи»)
 * is here so the list is the one place to look.
 */
export const HYPHEN_NAMES: readonly string[] = [
  'Санкт-Петербург',
  'Ростов-на-Дону',
  'Нью-Йорк',
  'Комсомольск-на-Амуре',
  'Орехово-Зуево',
  'Йошкар-Ола',
  'Улан-Удэ',
  'Ханты-Мансийск',
  'Wi-Fi',
  '1С-Битрикс',
  '1С:Франчайзи',
  // Short forms of words: «в р-не», «г-ну Иванову», «ж-д билет».
  'р-н',
  'г-н',
  'г-жа',
  'ж-д',
  'т-во',
]

/** The longest ending a case form of a listed name may have in one of its parts («Ростова-на-Дону», «Нью-Йорком»). */
const CASE_ENDING_MAX = 3
/** Latin letters that look like Cyrillic ones: a name typed with a Latin «C» in «1C-Битрикс» is the same name. */
const LOOKALIKE: Record<string, string> = {
  a: 'а',
  b: 'в',
  c: 'с',
  e: 'е',
  h: 'н',
  k: 'к',
  m: 'м',
  o: 'о',
  p: 'р',
  t: 'т',
  x: 'х',
  y: 'у',
}
/** A part of a word to compare: lower case, a look-alike Latin letter as the Cyrillic one. */
const likeCyrillic = (part: string): string =>
  part.toLowerCase().replace(/[a-z]/g, (ch) => LOOKALIKE[ch] ?? ch)

const LISTED = HYPHEN_NAMES.map((name) => name.split('-').map(likeCyrillic))

/** The places between the parts of a word where a listed name has its own hyphen. */
function listedHyphens(parts: string[]): boolean[] {
  const keep = parts.slice(1).map(() => false)
  const folded = parts.map(likeCyrillic)
  for (const own of LISTED) {
    if (own.length < 2) continue
    for (let at = 0; at + own.length <= parts.length; at++) {
      const same = own.every((o, j) => {
        const p = folded[at + j] ?? ''
        return p.startsWith(o) && p.length - o.length <= CASE_ENDING_MAX
      })
      if (same) for (let j = 0; j < own.length - 1; j++) keep[at + j] = true
    }
  }
  return keep
}

/** Days of the week in short: «пн-пт», «сб-вс» keep their hyphen. */
const WEEKDAY = /^(?:пн|вт|ср|чт|пт|сб|вс)$/iu
const isNumber = (p: string) => /^\d+%?$/.test(p)
const isLatin = (p: string) => /^[A-Za-z0-9]+$/.test(p) && /[A-Za-z]/.test(p)

/**
 * Which hyphens of a word stay (rule 3), decided hyphen by hyphen between the two parts it joins. Boris writes
 * «B2B компании», «Telegram бот», «SEO продвижение»: a hyphen stays only
 * - next to a number: a phone number, a date, a range («2-3», «10-15%») and a number with its ending («5-летний», «2-й»);
 * - between two parts that are Latin all through («Wi-Fi», «e-mail», «A-Store», «B2B-SaaS»), so «Wi-Fi-роутер» is
 *   «Wi-Fi роутер»;
 * - inside a name of `HYPHEN_NAMES` («1С-Битрикс», «Санкт-Петербурга», a Latin «C» for the Cyrillic one too);
 * - in a short day of the week («пн-пт»);
 * - in a Cyrillic proper name whose parts are all capitalized («Анна-Мария») or capitalized with a link word in lower
 *   case («Ростов-на-Дону»).
 * In «что-то», «все-таки», «по-русски», «Что-то» (a capital at the start of a sentence), «SEO-продвижение» and
 * «B2B-сегмент» the hyphen goes. When in doubt about a name, its hyphen stays: a hurt name costs more.
 */
function withKeptHyphens(word: string): string {
  const parts = word.split('-')
  const capital = (p: string) => /^\p{Lu}/u.test(p)
  const [head, ...rest] = parts
  const properName =
    !/[A-Za-z]/.test(word) &&
    (parts.every(capital) ||
      (capital(head ?? '') &&
        rest.every((p) => capital(p) || NAME_LINKS.has(p)) &&
        rest.some(capital)))
  const listed = listedHyphens(parts)
  return parts.reduce((out, part, i) => {
    if (i === 0) return part
    const before = parts[i - 1] ?? ''
    const keep =
      properName ||
      listed[i - 1] === true ||
      isNumber(before) ||
      isNumber(part) ||
      (isLatin(before) && isLatin(part)) ||
      (WEEKDAY.test(before) && WEEKDAY.test(part))
    return `${out}${keep ? '-' : ' '}${part}`
  }, '')
}

/** A dash with the spaces around it, a spaced or line-leading hyphen: all of them are the same dash to remove. */
const DASH_SIGN = new RegExp(
  `${GAP}*[${DASH}]+${GAP}*|${GAP}+-+(?=${GAP}|$)${GAP}*|^-+${GAP}+`,
  'gmu',
)
/** A dash with numbers on both sides: a range, a phone, a date, or something that is no range at all. */
const NUMBER_DASH = new RegExp(
  `(?<=\\d%?)(?:${GAP}*[${DASH}]+${GAP}*|${GAP}+-${GAP}+)(?=\\d)`,
  'gu',
)
const NUMBER_BEFORE = /(\d+(?:[ \u00a0]\d{3})*(?:[.,:]\d+)?)%?$/u
const NUMBER_AFTER = /^\d+(?:[ \u00a0]\d{3})*(?:[.,:]\d+)?/u
/** The value of a number as written («50 000», «1,5», «9:30»), to tell which of two is the greater. */
function numberValue(written: string): number {
  const t = written.replace(/[ \u00a0]/g, '')
  if (t.includes(':')) {
    const [h, m] = t.split(':')
    return Number(h) + Number(m) / 60
  }
  return Number(t.replace(',', '.'))
}
/**
 * A dash between two numbers is a range, and a range is written with a short hyphen: «2-3 недели», «10-15%», «9:00-18:00».
 * With no space around it nothing else is possible (a phone, a date). With spaces it is a range only from the smaller
 * number to the greater one; «5000 - 3 этапа» is two things said one after the other, so a comma stands there.
 */
function numberDash(dash: string, at: number, whole: string): string {
  if (!/[ \t\u00a0]/.test(dash)) return '-'
  const left = NUMBER_BEFORE.exec(whole.slice(0, at))?.[1]
  const right = NUMBER_AFTER.exec(whole.slice(at + dash.length))?.[0]
  if (left === undefined || right === undefined) return '-'
  return numberValue(left) < numberValue(right) ? '-' : ', '
}
const WORD_WITH_HYPHEN = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+/gu

function removeDashes(text: string): string {
  const ranged = text.replace(NUMBER_DASH, numberDash)
  const gone = ranged.replace(DASH_SIGN, (m, offset: number, whole: string) => {
    const before = whole[offset - 1]
    const after = whole[offset + m.length]
    // At the start or the end of a line, before a sign of punctuation or after an opening bracket the dash leaves
    // nothing behind; between words it leaves one space.
    if (before === undefined || before === '\n' || before === '(' || before === '«') return ''
    if (after === undefined || after === '\n' || /[,.;:!?)»]/.test(after)) return ''
    return ' '
  })
  return gone.replace(WORD_WITH_HYPHEN, withKeptHyphens)
}

/** Short words whose period is theirs («30 000 руб.», «2020 г.»): written without the dot, before the period. */
const ABBREVIATIONS = new Set([
  'руб',
  'тыс',
  'млн',
  'г',
  'гг',
  'др',
  'пр',
  'ул',
  'д',
  'кв',
  'см',
  'рис',
  'т.е',
  'т.д',
  'т.п',
])
/** A token of dotted letters, «т.д.», «т.п.», «e.g.»: its last period is its own. */
const DOTTED = /(?:\p{L}{1,3}\.){2,}$/u
/** Whether the text ends with an abbreviation, whose period closes the word and not the sentence. */
function endsInAbbreviation(head: string): boolean {
  const last = head.split(/\s/).pop() ?? ''
  return DOTTED.test(last) || ABBREVIATIONS.has(last.slice(0, -1).toLowerCase())
}

/**
 * The line without the period that closes it. «Хм..» and «Хм...» keep theirs, an emoji at the end stays, and so does
 * the period of an abbreviation at the end («и т.д.», «30 000 руб.»).
 */
function dropFinalPeriod(line: string): string {
  const tail = EMOJI_TAIL.exec(line)?.[0] ?? ''
  const head = line.slice(0, line.length - tail.length)
  if (!/(?<![.…])\.$/.test(head) || endsInAbbreviation(head)) return line
  const cut = head.slice(0, -1)
  return tail && !/^\s/.test(tail) ? `${cut} ${tail}` : `${cut}${tail}`
}

/**
 * The text of a client message the way Boris writes it (rules 3, 4, 15): no «ё» (it is «е»), no long or medium dash, no hyphen in
 * common words («что то»), no period at the end of a paragraph or a line, one empty line between paragraphs,
 * trimmed spaces. A hyphen stays in names, brands, numbers and links; «?», «!», «…» and «)» at the end stay;
 * emoji are not touched. A single line break inside a paragraph stays, and the line before it loses its final
 * period like a paragraph does. Applying it twice gives the same text.
 */
export function fixClientText(text: string): string {
  // A pass can leave something for the next one (a dash taken away leaves a period at the end, «Текст. .» leaves
  // «Текст.»): it goes on until the text no longer changes, so the result is a text that fixing leaves as it is.
  let out = fixOnce(text)
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = fixOnce(out)
    if (next === out) break
    out = next
  }
  return out
}

/** The most passes after the first one that fixing takes; in practice one more is the most it needs. */
const MAX_PASSES = 8

function fixOnce(text: string): string {
  const saved: string[] = []
  const hidden = text
    .replace(/\r\n?/g, '\n')
    .replace(TYPOGRAPHIC_HYPHEN, '-')
    .replace(PROTECTED, (m) => {
      saved.push(m)
      return String.fromCharCode(SLOT_BASE + saved.length - 1)
    })
    // Boris, 31.10.2026: «в письмах не должно быть буквы ё, вместо неё е».
    .replace(/ё/g, 'е')
    .replace(/Ё/g, 'Е')
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
 * The forms a greeting of ours takes (Boris, 11.11.2026: «Все время разный как у человека»): «Алексей, добрый день!»,
 * «Добрый день, Алексей!», «Здравствуйте, Алексей!», «Алексей, здравствуйте!». Without a name «Добрый день!» or
 * «Здравствуйте!». The first is the one Sara always opened with.
 */
export const GREETING_FORMS = ['name_first', 'name_after', 'hello_after', 'hello_first'] as const
export type GreetingForm = (typeof GREETING_FORMS)[number]

const capital = (w: string) => `${w.charAt(0).toUpperCase()}${w.slice(1)}`

/**
 * The greeting of a message built at send time, in its form: the part of the day by the hour in Moscow («Доброе утро»,
 * «Добрый день», «Добрый вечер»), «Здравствуйте» at any hour. The model never writes it.
 */
export function greetingFor(
  now: Date,
  name: string | null,
  form: GreetingForm = 'name_first',
): string {
  const hello = form === 'hello_after' || form === 'hello_first'
  const word = hello ? 'здравствуйте' : NOMINATIVE[moscowPartOfDay(now)]
  const known = nameOf(name)
  if (!known) return `${capital(word)}!`
  return form === 'name_first' || form === 'hello_first'
    ? `${known}, ${word}!`
    : `${capital(word)}, ${known}!`
}

// A name before or after the greeting: a capitalized word, or the tag of ADR-016 the model is given.
const GREETING_NAME = String.raw`(\p{Lu}[\p{L}-]*|\[имя \d+\])`
const GREETING_WORD = String.raw`([Дд]обр(?:ое\s+утро|ый\s+день|ый\s+вечер)|[Дд]оброго\s+(?:дня|утра|вечера)|[Зз]дравствуй(?:те)?|[Пп]риветствую|[Пп]ривет)`
const GREETING_END = String.raw`\s*[!.]?$`
/** «Анна, добрый день!», «Анна, здравствуйте!». */
const NAME_THEN_WORD = new RegExp(
  String.raw`^${GREETING_NAME},\s*${GREETING_WORD}${GREETING_END}`,
  'u',
)
/** «Добрый день!», «Добрый день, Анна!», «Здравствуйте, Анна!», «Доброго дня, Анна!». */
const WORD_THEN_NAME = new RegExp(
  String.raw`^${GREETING_WORD}(?:,\s*${GREETING_NAME})?${GREETING_END}`,
  'u',
)

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

/** The word of a greeting as its kind: a part of the day, the genitive, «здравствуйте», «приветствую», «привет». */
function wordKind(word: string): string {
  const w = fold(word)
  return w.startsWith('доброго')
    ? 'gen'
    : w.startsWith('добр')
      ? 'day'
      : w.startsWith('здравств')
        ? 'hello'
        : w.startsWith('приветств')
          ? 'greet'
          : 'hi'
}

/** A greeting taken apart: its word, the name and where it stands; null when the text is not one greeting. */
function greetingParts(
  text: string,
): { word: string; name: string | null; where: 'before' | 'after' | 'none' } | null {
  const t = text.trim()
  const before = NAME_THEN_WORD.exec(t)
  if (before) {
    const [, name = '', word = ''] = before
    // «Понимаю, добрый день!» opens with a word that is no name.
    return NOT_NAMES.has(fold(name)) ? null : { word, name, where: 'before' }
  }
  const after = WORD_THEN_NAME.exec(t)
  if (!after) return null
  const [, word = '', name] = after
  return name ? { word, name, where: 'after' } : { word, name: null, where: 'none' }
}

/** The first sentence of a text, up to its «!», «.», «?» or the end of its line. */
const firstSentence = (text: string): string =>
  /^[^\n!.?]*[!.?]?/.exec(text.trimStart())?.[0].trim() ?? ''

/**
 * The shape of the greeting a text opens with: its kind of word and where the name stands («day:before» for «Анна, добрый
 * день!» at any hour, «hello:after» for «Здравствуйте, Анна!»); null when its first sentence is no greeting.
 */
export function greetingShape(text: string): string | null {
  const p = greetingParts(firstSentence(text))
  return p ? `${wordKind(p.word)}:${p.where}` : null
}

/** The client's name a message of ours greeted with, before or after the greeting; null for none or a tag. */
export function greetedName(text: string): string | null {
  const name = greetingParts(firstSentence(text))?.name ?? null
  return name && !name.startsWith('[') ? name : null
}

/** A stable number of a seed (FNV-1a): the same order or message always gets the same form, never chance. */
function seedNumber(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0
  return h
}

const ANY_HOUR = new Date('2026-01-15T10:00:00Z')

/**
 * The form of the next greeting of ours: not the shape of the latest greetings (`before`, newest first: a chat's
 * messages, or the latest bids to other clients), two of them while a form is left, else the latest one. Among the forms
 * left the seed (the order, the chat and the number of its message) chooses, so a repeat of the step chooses the same.
 * With no greeting before, the one Sara always opened with.
 */
export function pickGreetingForm(
  seed: string,
  name: string | null,
  before: readonly string[],
): GreetingForm {
  const shapes = before.map(greetingShape).filter((s): s is string => s !== null)
  if (shapes.length === 0) return 'name_first'
  const shapeOf = (f: GreetingForm) => greetingShape(greetingFor(ANY_HOUR, name, f))
  for (const n of [2, 1]) {
    const avoid = new Set(shapes.slice(0, n))
    const left = GREETING_FORMS.filter((f) => !avoid.has(shapeOf(f) ?? ''))
    if (left.length > 0) return left[seedNumber(seed) % left.length] as GreetingForm
  }
  return 'name_first'
}

/** The part of the day a text greets for when the whole text is one greeting in an allowed form, else null. */
function greetingPart(text: string): PartOfDay | 'any' | null {
  const p = greetingParts(text)
  if (!p) return null
  const kind = wordKind(p.word)
  if (kind === 'hello') return 'any'
  if (kind !== 'day' && kind !== 'gen') return null
  const word = fold(p.word)
  return word.includes('утр') ? 'morning' : word.includes('веч') ? 'evening' : 'day'
}

/**
 * Whether a text is one greeting in a form Boris allows: «Добрый день!», «Анна, доброе утро!», «Добрый день, Анна!»,
 * «Доброго дня, Анна!», «Здравствуйте!», «Здравствуйте, Анна!», «Анна, здравствуйте!» (11.11.2026). Not «Привет!».
 * With `now` the part of the day must also be the one of that moment in Moscow («Здравствуйте» fits any).
 */
export function isGreetingForm(text: string, now?: Date): boolean {
  const part = greetingPart(text)
  return part !== null && (now === undefined || part === 'any' || part === moscowPartOfDay(now))
}

/** The greeting a text opens with, when its first sentence is one in an allowed form (else null). */
export function leadingGreeting(text: string): string | null {
  const first = /^[^\n!.]*[!.]?/.exec(text.trimStart())?.[0].trim() ?? ''
  return first && isGreetingForm(first) ? first : null
}
