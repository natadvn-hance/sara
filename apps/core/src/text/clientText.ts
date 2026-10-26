/**
 * The text a client reads (M4 part V, Boris's 15 voice decisions of 26.10): one module for the bids of the Analyst
 * and for the replies of the Interlocutor. Pure functions only: nothing here reads a clock, a database or a model.
 * Long and medium dashes are written below as escapes, never as the characters (CI forbids the long one in files).
 */

import type { CheckId, Tone } from '@sara/shared'
import { NOT_NAMES } from '../conversation/check/phrases'
import { firstName } from '../leads/clientName'

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

// ---------------------------------------------------------------------------------------------------------------
// Rule 6: a substantive reply starts with the client's name, a short one goes without it

/**
 * Whether a text opens with the client's name (the first word of what Profi.ru gave, any letter case, ё as е), as a
 * whole word: «Анна, понял вас» does, «Аннализа, ...», «Анна-Мария, ...» (for the name Анна) and «Понял вас, Анна»
 * do not. The tag the model is given for the name, «[имя 1]», counts as the name. No name, no start with it.
 */
export function startsWithName(text: string, name: string | null): boolean {
  const first = name ? firstName(name) : null
  if (!first) return false
  const head = fold(text.trimStart())
  if (/^\[имя \d+\]/u.test(head)) return true
  const own = fold(first)
  return head.startsWith(own) && !/^[\p{L}\p{N}-]/u.test(head.slice(own.length))
}

/** A short reply: at most this many words (SHORT_REPLY_WORDS), characters, sentences, and no question. */
export const SHORT_REPLY_WORDS = 5
export const SHORT_REPLY_CHARS = 40
export const SHORT_REPLY_SENTENCES = 2

const EMOJI_RUN = new RegExp(`${EMOJI_PART}+`, 'gu')

/**
 * Whether a reply is a nod and not an answer, so it needs no name at its start («Принял», «Договорились 🤝», «Отлично,
 * жду»). Short means all of: no question mark, at most 5 words, at most 40 characters (emoji not counted), at most 2
 * sentences (a line break ends a sentence too). One more word, one more sentence or a question makes it substantive.
 * Empty text is short: there is nothing to put a name before.
 */
export function isShortReply(text: string): boolean {
  const bare = text.replace(EMOJI_RUN, ' ')
  if (bare.includes('?')) return false
  const words = bare.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? []
  const sentences = bare.split(/[.!…\n]+/).filter((s) => /[\p{L}\p{N}]/u.test(s))
  return (
    words.length <= SHORT_REPLY_WORDS &&
    sentences.length <= SHORT_REPLY_SENTENCES &&
    bare.replace(/\s+/g, ' ').trim().length <= SHORT_REPLY_CHARS
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Rules 6, 7, 8, 12, 14: what a reply must not promise, say or show

export type VoiceIssueId = Extract<CheckId, `voice.${string}`>
export type VoiceIssue = { id: VoiceIssueId; detail: string }

export type VoiceInput = {
  text: string
  /** The first message of a conversation (a first reply after the bid): one question at most. */
  firstMessage: boolean
  /** The client's tone as the Interlocutor read it; null when it did not. */
  tone: Tone | null
  /** The reply brings bad news: a refusal, a delay, «не успеем». */
  badNews: boolean
  /** Our earlier messages of this conversation, for the repeat of a phrase. */
  ourPrevious: string[]
  name: string | null
  /** The client's last turn: read for an official «Вы» and for words of an upset client (rule 8). */
  clientTurn?: string
  /** The client writes officially («Вы» with a capital); the caller may say so when it knows better than the turn. */
  clientOfficial?: boolean
  /** The client is upset or anxious (disappointment, worry: no Tone for these); the caller may set it. */
  clientUpset?: boolean
}

const B = String.raw`(?<!\p{L})`
const E = String.raw`(?!\p{L})`

// Verbs of Boris's own work in the first person future («пришлю», «подготовим»): any object makes the promise.
const SEND_OR_PREPARE =
  'пришлю|пришлем|вышлю|вышлем|отправлю|отправим|скину|скинем|кину|кинем|закину|закинем|перешлю|перешлем|' +
  'подготовлю|подготовим|составлю|составим|сформирую|сформируем|накидаю|накидаем|набросаю|набросаем|' +
  'нарисую|нарисуем|посчитаю|посчитаем|рассчитаю|рассчитаем|прикину|прикинем|оценю|оценим'
// «Сделаю расчёт», «КП за два дня»: a document of Boris's with a verb of making or a term. «Сделаем сайт» is the service.
const DOCUMENT = String.raw`кп|коммерческ\p{L}+\s+предложени\p{L}*|предложени\p{L}*|смет\p{L}*|расчет\p{L}*|презентаци\p{L}*|оценк\p{L}*`
const MAKE = 'сделаю|сделаем|соберу|соберем'
// «Посмотрю сайт», «изучу ваши соцсети»: looking at something of the client's. «Посмотрю задачу» is not one.
const LOOK =
  'посмотрю|посмотрим|изучу|изучим|проанализирую|проанализируем|проверю|проверим|разберу|разберем'
const LOOK_AT = String.raw`сайт\p{L}*|страниц\p{L}*|аккаунт\p{L}*|профил\p{L}*|соцсет\p{L}*|конкурент\p{L}*|материал\p{L}*|бриф\p{L}*|заявк\p{L}*|проект\p{L}*|макет\p{L}*|лендинг\p{L}*|кабинет\p{L}*|рекламн\p{L}*|кампани\p{L}*|выдач\p{L}*|презентаци\p{L}*|смет\p{L}*|документ\p{L}*`
const TERM = String.raw`\d+|один|два|две|три|четыре|пять|шесть|семь|ден\p{L}*|дн\p{L}*|час\p{L}*|недел\p{L}*|месяц\p{L}*|завтра|сегодня|послезавтра|пятниц\p{L}*|понедельник\p{L}*|вторник\p{L}*|сред\p{L}*|четверг\p{L}*|суббот\p{L}*|воскресен\p{L}*`

const PROMISES = [
  new RegExp(`${B}(?:${SEND_OR_PREPARE})${E}`, 'u'),
  new RegExp(String.raw`${B}(?:${MAKE})(?:\s+\p{L}+){0,2}?\s+(?:${DOCUMENT})${E}`, 'u'),
  new RegExp(String.raw`${B}(?:${LOOK})(?:\s+\p{L}+){0,2}?\s+(?:${LOOK_AT})${E}`, 'u'),
  new RegExp(
    String.raw`${B}(?:${DOCUMENT})(?:\s+\p{L}+){0,3}?\s+(?:за|через|в\s+течени\p{L}*|к|до|не\s+позднее)\s+(?:\p{L}+\s+){0,2}?(?:${TERM})${E}`,
    'u',
  ),
]
/** «Веду лично», «займусь лично», «буду вести проект лично»: a verb of leading and the word «лично» in one sentence. */
const LEAD_VERB = new RegExp(
  String.raw`${B}(?:веду|ведем|займусь|займемся|возьму|возьмем|проконтролирую|проконтролируем|курирую|курируем|(?:буду|будем|будет)\s+(?:лично\s+)?(?:вести|курировать|контролировать|заниматься|сопровождать))${E}`,
  'u',
)
const PERSONALLY = new RegExp(`${B}лично${E}`, 'u')

function promiseIssue(text: string): VoiceIssue | null {
  const folded = fold(text)
  for (const re of PROMISES) {
    const m = re.exec(folded)
    if (m) return promised(m[0])
  }
  for (const sentence of folded.split(/[.!?…;\n]+/)) {
    const verb = LEAD_VERB.exec(sentence)
    if (verb && PERSONALLY.test(sentence)) return promised(sentence.trim().slice(0, 60))
  }
  return null
}
const promised = (quote: string): VoiceIssue => ({
  id: 'voice.promise_action',
  detail: `обещание действия Бориса: «${quote}». Такой ответ уйдёт Борису черновиком`,
})

// Past forms and short adjectives of a woman speaking (folded). Sara writes in Boris's name: «понял», «рад».
const FEMININE_VERBS = new Set(
  [
    'поняла заметила посмотрела подготовила сделала увидела прочитала изучила проверила уточнила отправила написала ' +
      'ответила рассмотрела учла приняла подумала решила нашла обсудила записала отметила посчитала собрала получила ' +
      'передала связалась договорилась согласилась обратила оценила разобралась проанализировала ознакомилась ' +
      'спросила узнала выяснила составила приготовила прислала вернулась подключилась успела смогла начала закончила ' +
      'предложила рекомендовала посоветовала подсказала показала объяснила рассказала назвала предупредила старалась ' +
      'постаралась хотела ждала думала',
  ].flatMap((line) => line.split(' ')),
)
const FEMININE_ADJECTIVES = new Set([
  'рада',
  'согласна',
  'уверена',
  'благодарна',
  'признательна',
  'готова',
])
/** A feminine subject of a third party before the verb: «команда сделала», «она поняла», «которая сделала». */
const FEMININE_SUBJECTS = new Set(
  (
    'она которая эта та ваша наша моя ее команда студия компания фирма система платформа площадка реклама кампания ' +
    'работа задача версия страница заявка клиника школа организация служба поддержка биржа нейросеть'
  ).split(' '),
)
/** Words that may stand between «я» and the adjective or verb, or open a clause before it. */
const FILLERS = new Set(
  (
    'я уже тоже также еще вот все пока очень так искренне действительно вообще всегда безусловно конечно да ну же ' +
    'и а но не бы быстро внимательно подробно сразу только сегодня вчера сейчас ничего спасибо отлично хорошо итак ' +
    'тогда кстати'
  ).split(' '),
)
const PAST_FEMININE = /^\p{L}{2,}(?:ла|лась)$/u

function feminineIssue(text: string): VoiceIssue | null {
  for (const clause of fold(text).split(/[.!?;:,()\n…]+/)) {
    const words = clause.match(/\p{L}+/gu) ?? []
    for (const [k, word] of words.entries()) {
      const before = words.slice(0, k)
      const found = FEMININE_ADJECTIVES.has(word)
        ? before.every((w) => FILLERS.has(w))
        : FEMININE_VERBS.has(word)
          ? !before.some((w) => FEMININE_SUBJECTS.has(w))
          : PAST_FEMININE.test(word) && speaksOfHerself(before)
      if (found)
        return {
          id: 'voice.feminine',
          detail: `женский род от имени Бориса: «${word}», нужен мужской («понял», «рад»)`,
        }
    }
  }
  return null
}
/** «Я бы хотела», «я уже начала»: «я», up to two fillers, then the verb. */
function speaksOfHerself(before: string[]): boolean {
  let j = before.length - 1
  for (
    let steps = 0;
    j >= 0 && before[j] !== 'я' && FILLERS.has(before[j] ?? '') && steps < 2;
    steps++
  )
    j--
  return before[j] === 'я'
}

/** A link with a query («hance.ru/?a=1») holds a question mark that is no question. */
const LINK_WITH_QUERY = /\S*[/.]\S*\?[\p{L}\p{N}]\S*/gu

function questionsIssue(text: string): VoiceIssue | null {
  const count = (text.replace(LINK_WITH_QUERY, ' ').match(/\?+[!?]*/g) ?? []).length
  return count > 1
    ? {
        id: 'voice.many_questions',
        detail: `в первом сообщении вопросов: ${count}, а нужен один (остальные в следующих)`,
      }
    : null
}

const ALLOWED_EMOJI = new Set(['🤝', '🙏', '😊', '👍'])
/**
 * Tones in which a smile is out of place: irritation, rudeness and a hurry («коротко и по делу, без шуток»). A doubting
 * or a bargaining client may be answered with 😊 or 🙏 (Boris's examples), so those tones are not here. An official
 * client and an upset one are not tones, they are read from the client's turn (`isOfficialClient`, `isUpsetClient`).
 */
const SERIOUS_TONES: Partial<Record<Tone, string>> = {
  irritation: 'раздражение',
  rudeness: 'грубость',
  hurry: 'спешка',
}

/** «Вы», «Вас», «Вам», «Вами», «Ваш...» with a capital. */
const CAPITAL_YOU = /(?<!\p{L})В(?:ы|ас|ам|ами|аш\p{L}*)(?!\p{L})/gu
/** What may stand between a sentence start and the word: spaces and opening quotes or brackets. */
const BEFORE_WORD = /[ \t «"'([„]+$/u
const SENTENCE_END = new RegExp(`[.!?\\u2026\\n${DASH}]$`, 'u')

/**
 * Whether the client writes officially: «Вы» (or «Вас», «Вам», «Ваш...») with a capital in the middle of a
 * sentence, «сколько у Вас стоит». A capital at the start of a sentence is only the start of a sentence.
 */
export function isOfficialClient(clientTurn: string): boolean {
  for (const m of clientTurn.matchAll(CAPITAL_YOU)) {
    const before = clientTurn.slice(0, m.index).replace(BEFORE_WORD, '')
    if (before !== '' && !SENTENCE_END.test(before)) return true
  }
  return false
}

/** «Расстроен», «разочарован», «волнуюсь», «переживаю», «тревожно» and their forms of a person speaking of himself. */
const UPSET = new RegExp(
  `${B}(?:расстро(?:ен|ена|ены|ился|илась|ились)|разочаров(?:ан|ана|аны|ался|алась|ались)|волну(?:юсь|емся)|переживаю|переживаем|тревожно|тревожусь|тревожимся)${E}`,
  'u',
)

/** Whether the client's turn says he is upset or anxious: no smile then (rule 8). */
export function isUpsetClient(clientTurn: string): boolean {
  return UPSET.test(fold(clientTurn))
}
// The glue of an emoji sequence: the variation selector 16, the zero width joiner, the skin tones. Built from
// character codes: written as a plain class, a joiner in a class is a lint error and a trap for the reader.
const VARIATION_16 = String.fromCharCode(0xfe0f)
const JOINER = String.fromCharCode(0x200d)
const EMOJI_MODIFIERS = new RegExp(`${VARIATION_16}|${JOINER}|[\\u{1F3FB}-\\u{1F3FF}]`, 'gu')
const KEYCAP = String.fromCharCode(0x20e3)
const EMOJI_SIGN = new RegExp(
  `\\p{Extended_Pictographic}|\\p{Regional_Indicator}|[#*0-9]${KEYCAP}`,
  'gu',
)
const NOT_EMOJI = new Set(['©', '®', '™'])
const LIST_NUMBER = /^[ \t]*\d{1,2}\)/gm

/** The emoji of a text, one sign each, without the glue of a sequence and without ©, ® and ™. */
function emojiOf(text: string): string[] {
  const signs = text.replace(EMOJI_MODIFIERS, '').match(EMOJI_SIGN) ?? []
  return signs.filter((s) => !NOT_EMOJI.has(s))
}

/** The «)» that close no «(»: smiles. A number of a list line («1)») is no smile. */
function smileBrackets(text: string): number {
  let depth = 0
  let smiles = 0
  for (const ch of text.replace(LIST_NUMBER, (m) => ' '.repeat(m.length))) {
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth > 0) depth--
      else smiles++
    }
  }
  return smiles
}

function emojiIssue(i: VoiceInput): VoiceIssue | null {
  const emoji = emojiOf(i.text)
  const smiles = smileBrackets(i.text)
  const reasons: string[] = []
  const serious = i.tone ? SERIOUS_TONES[i.tone] : undefined
  if (emoji.length > 0 || smiles > 0) {
    if (i.badNews) reasons.push('смайл или эмодзи при плохой новости')
    if (serious) reasons.push(`смайл или эмодзи при тоне клиента «${serious}»`)
    if (i.clientOfficial || (i.clientTurn && isOfficialClient(i.clientTurn)))
      reasons.push('смайл или эмодзи официальному клиенту: он пишет «Вы» с большой буквы')
    if (i.clientUpset || (i.clientTurn && isUpsetClient(i.clientTurn)))
      reasons.push('смайл или эмодзи расстроенному или встревоженному клиенту')
  }
  if (reasons.length === 0) {
    if (smiles > 2) reasons.push(`скобок-смайлов ${smiles}, а можно не больше двух`)
    const strange = [...new Set(emoji.filter((e) => !ALLOWED_EMOJI.has(e)))]
    if (strange.length > 0)
      reasons.push(`эмодзи ${strange.join(' ')} не из разрешённых (🤝 🙏 😊 👍)`)
  }
  return reasons.length > 0 ? { id: 'voice.emoji_tone', detail: reasons.join('; ') } : null
}

const CODES = new RegExp(`[-${DASH}]`, 'g')
const NUMBER = String.raw`(?:\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,]\d+)?`
const MONTHS = 'январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр'
/** A range of two numbers with a hyphen or a dash between them, spaces allowed: «15-20», «10%-15%», «50 000 - 60 000». */
const NUMBER_RANGE = new RegExp(
  `(?<![\\p{L}\\d.,-])${NUMBER}%?[ \\u00a0]?[-${DASH}][ \\u00a0]?${NUMBER}`,
  'gu',
)
/** What looks like a range and is not one: phones, times and dates. Each is blanked out before ranges are read. */
const NOT_RANGES: [RegExp, ((m: string) => boolean)?][] = [
  // A phone with a plus: +7 (918) 123-45-67, +375 29 123-45-67.
  [new RegExp(String.raw`\+\d[\d\s()${DASH}-]{8,}\d`, 'gu'), (m) => digitsIn(m) >= 10],
  // A phone of 11 digits that starts with 8: 8 (918) 123-45-67, 8-800-555-35-35.
  [new RegExp(String.raw`(?<![\d.,-])8[\d\s()${DASH}-]{9,}\d`, 'gu'), (m) => digitsIn(m) === 11],
  // Three numbers or more with hyphens: 123-45-67, 2026-10-27.
  [new RegExp(String.raw`(?<![\d.,-])\d+(?:[-${DASH}]\d+){2,}(?![\d-])`, 'gu')],
  [/\d{1,2}:\d{2}(?::\d{2})?/g],
  // 25.10, 25.10.2026: a day and a month of two digits, so «1,5» and «2.5» stay numbers.
  [/(?<![\d.,])(?:0?[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])(?:\.(?:\d{4}|\d{2}))?(?![\d]|[.,]\d)/g],
  // «25-27 октября».
  [new RegExp(String.raw`\d{1,2}[  ]?[-${DASH}][  ]?\d{1,2}[  ]+(?:${MONTHS})\p{L}*`, 'giu')],
]
const digitsIn = (s: string) => s.replace(/\D/g, '').length

function rangeIssue(text: string): VoiceIssue | null {
  let rest = text
  for (const [re, only] of NOT_RANGES)
    rest = rest.replace(re, (m) => (only && !only(m) ? m : ' '.repeat(m.length)))
  const found = [...new Set([...rest.matchAll(NUMBER_RANGE)].map((m) => m[0].replace(CODES, '-')))]
  if (found.length === 0) return null
  const quoted = found
    .slice(0, 3)
    .map((r) => `«${r}»`)
    .join(', ')
  return {
    id: 'voice.range',
    detail: `диапазон ${quoted} записан цифрами через дефис или тире, а нужно словами: «от 15 до 20», «2 или 3 недели»`,
  }
}

/** Words of a sentence as a key; the client's name does not count, so a repeat is found with or without it. */
const sentenceKey = (s: string, own: string) =>
  (fold(s).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w !== own).join(' ')
const SENTENCE_WORDS = 4

function repeatIssue(i: VoiceInput, own: string): VoiceIssue | null {
  const sentences = (text: string) =>
    text
      .split(/[.!?…\n]+/)
      .map((raw) => ({ raw: raw.trim(), key: sentenceKey(raw, own) }))
      .filter((s) => s.key.split(' ').length >= SENTENCE_WORDS)
  const said = new Set(i.ourPrevious.flatMap((p) => sentences(p).map((s) => s.key)))
  const again = sentences(i.text).find((s) => said.has(s.key))
  return again
    ? {
        id: 'voice.signature_repeat',
        detail: `повтор своей фразы из прошлых сообщений: «${again.raw}»`,
      }
    : null
}

function nameIssue(i: VoiceInput): VoiceIssue | null {
  const own = i.name ? firstName(i.name) : null
  if (!own || isShortReply(i.text) || startsWithName(i.text, i.name)) return null
  // «Доброго дня, Анна!» opens with the name inside the greeting.
  const greeting = leadingGreeting(i.text)
  const greeted: string[] = greeting ? (fold(greeting).match(/[\p{L}-]+/gu) ?? []) : []
  if (greeted.includes(fold(own))) return null
  return {
    id: 'voice.no_name',
    detail: `ответ по существу начинается не с имени клиента («${own}»)`,
  }
}

/**
 * What in a reply breaks the voice of Boris's decisions of 26.10: a promise of an action that only Boris does
 * (rule 12), more than one question in a first message (14), a smile with bad news or to a client who is irritated,
 * rude, in a hurry, official («Вы» with a capital) or upset (8), other emoji than 🤝 🙏 😊 👍 and more than two «)»
 * (8), a number range written with a hyphen or a dash (3), a phrase of ours said again (12), a woman's form in
 * Boris's name (7), and a reply by the essence that does not start with the client's name (6). At most one issue
 * of each kind, in that order of weight; nothing for an empty text.
 */
export function voiceIssues(i: VoiceInput): VoiceIssue[] {
  if (!i.text.trim()) return []
  const own = fold(i.name ? (firstName(i.name) ?? '') : '')
  return [
    promiseIssue(i.text),
    feminineIssue(i.text),
    nameIssue(i),
    i.firstMessage ? questionsIssue(i.text) : null,
    emojiIssue(i),
    rangeIssue(i.text),
    repeatIssue(i, own),
  ].filter((x): x is VoiceIssue => x !== null)
}

// ---------------------------------------------------------------------------------------------------------------
// Rule 13: «Вы бот?» goes to Boris

const SEP = String.raw`[\s,]+`
/** Words that may open a question before its subject: «А вы бот?», «Скажите, вы бот?». */
const OPENER = `(?:(?:а|ну|так|и|вот|скажите|подскажите|слушайте|извините|простите|кстати|скажи|подскажи|слушай|ответьте|ответь|честно|только)${SEP}){0,3}`
/** The one who is asked about: «вы», «ты», «это», «тут», «там». */
const ASKED = '(?:вы|ты|это|тут|там)'
/** Little words between the subject and the noun: «вы случайно не бот», «вы вообще живой». */
const FILL = String.raw`(?:(?:тоже|сейчас|просто|случайно|вообще|же|ли|не|все|уже|правда|реально|точно|что|такой|на\s+самом\s+деле)${SEP}){0,3}`
const PROGRAM = String.raw`(?:чат-?бот|бот|робот|нейросеть|нейронка|искусственный\s+интеллект|ии|ai|chat-?gpt|gpt|автоответчик|автомат|программа|алгоритм|машина|виртуальный\s+(?:ассистент|помощник)|автоматический\s+(?:ответ|ответчик|ассистент))`
const PROGRAM_WITH = String.raw`(?:чат-?ботом|ботом|роботом|нейросетью|нейронкой|искусственным\s+интеллектом|ии|ai|chat-?gpt|автоответчиком|программой|алгоритмом|машиной|виртуальным\s+ассистентом)`
const ALIVE = `(?:живой|живая|настоящий|настоящая|реальный|реальная)`
const PERSON = `(?:человек|человеком)`
const SPEAKS = `(?:отвечает|пишет|говорит|общается|ответил|написал|консультирует|отвечаете|пишете|говорите|общаетесь)`
/** After the noun a question may only run on with a few words: «или человек», «отвечает», «на самом деле». */
const RUN_ON = String.raw`(?:${SEP}(?:${SPEAKS}|или${SEP}(?:с${SEP})?\p{L}+|ли|да|нет|вообще|сейчас|тут|там|на\s+самом\s+деле))*`
const TALKING = `(?:общаюсь|общаемся|говорю|говорим|разговариваю|разговариваем|переписываюсь|переписываемся|пишу)`

const BOT_QUESTIONS = [
  // «Вы бот?», «Это ИИ отвечает?», «Вы не бот или человек?»
  `^${OPENER}${ASKED}${SEP}${FILL}${PROGRAM}${RUN_ON}$`,
  // «Вы живой человек?», «Вы вообще живой?», «Вы человек?», «Это человек пишет?»
  `^${OPENER}${ASKED}${SEP}${FILL}(?:${ALIVE}${SEP})?(?:${PERSON}|${ALIVE})${RUN_ON}$`,
  // «Мне отвечает человек или программа?», «Меня консультирует ИИ?»
  `^${OPENER}(?:мне|меня|нам|нас)${SEP}(?:сейчас${SEP}|тут${SEP})?(?:отвечает|пишет|консультирует|обслуживает|общается|отвечают|пишут)${SEP}(?:${PROGRAM}|${ALIVE}${SEP}${PERSON}|${PERSON}|${ALIVE})${RUN_ON}$`,
  // «Я общаюсь с ботом?», «Я с роботом общаюсь?», «Я разговариваю с живым человеком?»
  `^${OPENER}(?:я|мы)${SEP}(?:сейчас${SEP}|тут${SEP})?${TALKING}${SEP}с${SEP}(?:${PROGRAM_WITH}|живым${SEP}человеком|человеком)${RUN_ON}$`,
  `^${OPENER}(?:я|мы)${SEP}с${SEP}(?:${PROGRAM_WITH}|живым${SEP}человеком|человеком)${SEP}${TALKING}${RUN_ON}$`,
  // «Это вы лично пишете или бот?»
  `^${OPENER}(?:это${SEP})?(?:вы|ты)${SEP}(?:лично${SEP})?(?:пишете|отвечаете|пишешь|отвечаешь)${SEP}или${SEP}${PROGRAM}$`,
  // «Кто мне отвечает, человек?»
  `^${OPENER}кто${SEP}(?:(?:мне|сейчас|тут)${SEP}){0,2}(?:отвечает|пишет)${SEP}(?:${PROGRAM}|(?:${ALIVE}${SEP})?${PERSON})${RUN_ON}$`,
  // «С кем я общаюсь, с человеком или с ботом?»
  `^(?:с${SEP}кем${SEP}(?:я${SEP})?${TALKING}${SEP})?с${SEP}(?:живым${SEP})?человеком${SEP}или${SEP}с${SEP}${PROGRAM_WITH}$`,
].map((source) => new RegExp(source, 'u'))
/** «Бот или человек?» alone: the whole sentence, never the tail of a longer one («Нужен сайт, бот или человек?»). */
const BARE_CHOICE = new RegExp(
  `^(?:${PROGRAM}${SEP}или${SEP}(?:${PERSON}|${ALIVE})|${PERSON}${SEP}или${SEP}${PROGRAM})$`,
  'u',
)
const BOT_QUESTION_WORDS = 10

/** A sentence the way the patterns read it: folded, only letters, digits, hyphens and commas, one space between. */
const asked = (sentence: string) =>
  fold(sentence)
    .replace(/\s[-‒-―]+\s/g, ' ')
    .replace(/[^\p{L}\p{N}\s,-]+/gu, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Whether the client asks if he is talking to a bot, a robot, a neural network or an AI, or if there is a living
 * person: «Вы бот?», «Я с роботом общаюсь?», «Это ИИ отвечает?», «Вы живой человек?». A question about a bot as a
 * service («Чат-бот для записи делаете?», «Вы делаете ботов?») is not one. Read per sentence, and per tail of a
 * sentence after a comma («Здравствуйте, мне нужен сайт, вы бот?»); a sentence longer than 10 words is not read
 * (a question about the nature of Sara is short). Such a message goes to Boris with a draft (rule 13).
 */
export function isBotQuestion(text: string): boolean {
  for (const raw of text.split(/[.!?;\n…]+/)) {
    const sentence = asked(raw)
    if (!sentence || sentence.split(' ').length > BOT_QUESTION_WORDS) continue
    if (BARE_CHOICE.test(sentence)) return true
    const parts = sentence.split(', ')
    for (let k = 0; k < parts.length; k++) {
      const tail = parts.slice(k).join(', ')
      if (BOT_QUESTIONS.some((re) => re.test(tail))) return true
    }
  }
  return false
}
