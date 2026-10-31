import {
  AnalystOutput,
  type ClientInfo,
  type LeadSite,
  type ProfiOrder,
  parsePriceRange,
  plural,
} from '@sara/shared'
import { publicLink } from '../conversation/caseLink'
import { CASE_LINK } from '../conversation/check/phrases'
import type { CaseHit } from '../conversation/types'
import {
  analystProfileText,
  bidCeiling,
  caseReserve,
  placeCases,
  type ReplyProfile,
} from '../direction/reply'
import type { Gateway } from '../gateway/gateway'
import { siteSection } from '../site/view'
import { fixClientText, greetingFor, moscowPartOfDay } from '../text/clientText'
import { bidCaseProblems, bidCasesText, chosenCase } from './bidCases'
import { firstName, namesToHide } from './clientName'
import { chosenSites, type HanceSite, SITES_SHOWN, sameUrl, siteLine, sitesText } from './siteOrder'
import { sorterInput } from './sorter'

/** Profi.ru's bid form takes at most this many characters, the greeting included. */
export const BID_TEXT_MAX = 500

/**
 * What a draft is written from; the client's name only ever reaches the greeting, never the model: the gateway
 * hides it, the board's and the order page's, wherever the text says it.
 */
export type DraftSource = Pick<
  ProfiOrder,
  'title' | 'category' | 'city' | 'budget_text' | 'text' | 'client_name'
> & {
  /** What the order page says about the client; absent when the page was not read. Its name is only hidden from the model, never sent (ADR-016). */
  client_info?: (Pick<ClientInfo, 'name'> & Partial<ClientInfo>) | null
}

/** The Analyst's reading of the order and its short разбор, kept beside the draft. */
export type Analysis = Pick<AnalystOutput, 'reading' | 'hidden_need' | 'risk' | 'condition'>
export type Draft = {
  text: string
  priceRub: number | null
  /** The top of the range, «до» (31.10.2026); null: the program puts half again over «от». */
  priceToRub?: number | null
  attempts: number
  analysis: Analysis
  /** The ids of the cases that went into the text: the direction's (their links are the library's) and the mind's. */
  cases?: string[]
  /** The series after the bid (Boris, 29.10.2026): one or two short messages, a case's link already put in. */
  followUps?: string[]
  /** The ids of the cases the series shows by their links. */
  followUpCases?: string[]
  /** Why a message of the series the model wrote was left out; the bid itself stays. */
  followUpsDropped?: FollowUpMiss[]
  /** The sites of Hance the series shows by their links, for an order of a site (Boris, 30.10.2026). */
  followUpSites?: string[]
  /** The call offer that ends the series, its times still to be put in (Boris, 30.10.2026); none when it is off. */
  callOffer?: string
  /** The last message of the series: Boris's Telegram (31.10.2026). */
  telegram?: string
}
/** No text to send; a reading the model did give stays (its text was too long or not plain). */
export type DraftMiss = {
  text: null
  reason: 'no_answer' | 'too_long' | 'not_plain' | 'has_tag' | 'bad_case'
  attempts: number
  analysis: Analysis | null
}

const analysisOf = (o: AnalystOutput): Analysis => ({
  reading: o.reading,
  hidden_need: o.hidden_need,
  risk: o.risk,
  condition: o.condition,
})

/**
 * A greeting counts only in the first sentence: «Добрый день!», «Анна, добрый день!», «Здравствуйте, Анна.»
 * Whole words only: «Приветливый персонал» is no greeting.
 */
const OPENING_GREETING =
  /^[^.!?\n]{0,40}?(?<!\p{L})(?:добр(?:ый|ое|ого)\s+(?:день|дня|утро|утра|вечер|вечера|времени)|здравствуй(?:те)?|приветствую|привет)(?!\p{L})/iu
const FIRST_SENTENCE = /^[^.!?\n]*[.!?]*\s*/u
/** The model's own framing or JSON around the text (old Sara, 17.09 and 30.09): never typed into the form. */
const NOT_PLAIN = /^\s*[{[]|<\/?parameter\b/i
/**
 * A word in square brackets: a tag of ADR-016 the model made up and the gateway could not put back («[имя 4]»,
 * «[Имя]», «[ссылка на сайт]»). A bid has no use for brackets, and the client would read them.
 */
const BRACKETED = /\[[^\]\n]{1,40}\]/u

/**
 * The greeting of a moment in Moscow (Boris, 26.10, rule 5): «Ирина, доброе утро!» until 12:00, «Ирина, добрый день!»
 * until 18:00, «Ирина, добрый вечер!» after; «Доброе утро!» and so on when the name is not known (a missing hello is
 * rude, Boris 20.10). Without a moment it is the greeting of now. A bid is greeted at the moment it is SENT
 * (`bidTextAt`); this is the greeting a draft and the card are built with, and it changes with the hour.
 */
export function greetingOf(clientName: string, now: Date = new Date()): string {
  return greetingFor(now, clientName)
}

/** One moment in each part of the Moscow day (UTC+3 all year): 09:00, 13:00 and 20:00. */
const PARTS_OF_DAY = ['2026-01-15T06:00:00Z', '2026-01-15T10:00:00Z', '2026-01-15T17:00:00Z'].map(
  (iso) => new Date(iso),
)

/** The longest greeting of the day for this client, «Ирина, добрый вечер!»: the room a bid keeps for its greeting. */
export function longestGreeting(clientName: string): string {
  return PARTS_OF_DAY.map((t) => greetingOf(clientName, t)).reduce((a, b) =>
    b.length > a.length ? b : a,
  )
}

/**
 * The length a greeting may grow to in the course of the day: «добрый вечер» is a letter longer than «добрый день» and
 * «доброе утро». For a greeting already written, as in a sample of the direction.
 */
export function greetingRoom(greeting: string): number {
  return /вечер/iu.test(greeting) ? greeting.length : greeting.length + 1
}

/**
 * Rule 8: no emoji in a bid for now. One sign of an emoji, or the glue of a sequence (joiner, variation selector, keycap,
 * skin tone, a flag's letters). The marks of a brand (© ® ™) are no emoji. Built from a string: in a literal the
 * escapes would be rewritten into the invisible characters themselves.
 */
const EMOJI_SIGN = String.raw`(?:(?![\u00a9\u00ae\u2122])\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u200d\ufe0f\u20e3])`
const EMOJI = new RegExp(EMOJI_SIGN, 'gu')
const EMOJI_RUN = `${EMOJI_SIGN}+`
/** An emoji that stands before a sign of punctuation takes the space before it along: «важное 🤝.» is «важное.». */
const EMOJI_BEFORE_MARK = new RegExp(String.raw`[ \t]*${EMOJI_RUN}(?=[.,;:!?)])`, 'gu')
/** Brackets that held only an emoji: «Спасибо (🤝).» is «Спасибо.», «слово(🤝)слово» is two words. */
const EMOJI_BRACKETS_BEFORE_MARK = new RegExp(
  String.raw`[ \t]*\(\s*${EMOJI_RUN}\s*\)(?=[.,;:!?)])`,
  'gu',
)
const EMOJI_BRACKETS = new RegExp(String.raw`[ \t]*\(\s*${EMOJI_RUN}\s*\)`, 'gu')
/** «Принял. 🤝. Дальше»: the period before the emoji and the one after it are one. */
const EMOJI_BETWEEN_PERIODS = new RegExp(String.raw`\.[ \t]*${EMOJI_RUN}[ \t]*\.`, 'gu')
/** An emoji glued between two letters or digits stands for a space. */
const EMOJI_BETWEEN_WORDS = new RegExp(
  String.raw`(?<=[\p{L}\p{N}])${EMOJI_RUN}(?=[\p{L}\p{N}])`,
  'gu',
)
export function removeEmoji(text: string): string {
  return text
    .replace(EMOJI_BRACKETS_BEFORE_MARK, '')
    .replace(EMOJI_BRACKETS, (m, at: number, whole: string) =>
      /[\p{L}\p{N}]/u.test(whole[at - 1] ?? '') && /[\p{L}\p{N}]/u.test(whole[at + m.length] ?? '')
        ? ' '
        : '',
    )
    .replace(EMOJI_BETWEEN_PERIODS, '.')
    .replace(EMOJI_BEFORE_MARK, '')
    .replace(EMOJI_BETWEEN_WORDS, ' ')
    .replace(EMOJI, '')
}

export function greets(text: string): boolean {
  return OPENING_GREETING.test(text.trim())
}

/** The text without its opening greeting sentence. */
export function bodyOf(text: string): string {
  const t = text.trim()
  return greets(t) ? t.replace(FIRST_SENTENCE, '').trim() : t
}

/** What the voice rules make of a text (3, 4, 8, 15): no emoji, no dashes, no hyphen in a common word, no final period, one empty line. */
const plain = (s: string) => fixClientText(removeEmoji(s))

/** A text as the body of a bid: the voice rules applied, an opening greeting sentence taken off (for a sample of the direction). */
export const bidBodyOf = (text: string): string => bodyOf(plain(text))

/** The model's body behind the code's greeting; a greeting the model wrote anyway goes, it never knows the name. */
export function draftOf(body: string, clientName: string, now: Date = new Date()): string {
  return `${greetingOf(clientName, now)}\n\n${bodyOf(plain(body))}`
}

/** Boris's own text: his greeting stays; without one ours goes first (a bare «Ирина,» at the start joins it). */
export function editOf(text: string, clientName: string, now: Date = new Date()): string {
  const t = plain(text)
  if (greets(t)) return t
  const name = firstName(clientName)
  const rest = name ? t.replace(new RegExp(`^${name},\\s*`, 'iu'), '') : t
  return `${greetingOf(clientName, now)}\n\n${rest.charAt(0).toUpperCase()}${rest.slice(1)}`
}

const NAME = String.raw`(\p{L}[\p{L}-]*)`
const GREETING_WORD = String.raw`(?:[Дд]обр(?:ый\s+день|ое\s+утро|ый\s+вечер|ого\s+(?:дня|утра|вечера|времени))|[Зз]дравствуй(?:те)?|[Пп]риветствую|[Пп]ривет)`
/** A first sentence that is a greeting and nothing else, with a word before or after it, or none. */
const BARE_GREETING = new RegExp(
  String.raw`^(?:${NAME}[,\s]\s*)?${GREETING_WORD}(?:[,\s]\s*${NAME})?$`,
  'u',
)

const likeName = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

/**
 * Whether a first sentence is a greeting and nothing else: «Добрый день!», «Здравствуйте, Ирина!», «ирина, добрый
 * день!». The only name it may carry is the client's own first name on the board, in any case of letters; any other
 * word before or after the greeting («Спасибо», «Москва», a name Boris chose) makes it Boris's own sentence. The name
 * is the board's, or null for a greeting with no name.
 */
function bareGreeting(sentence: string, clientName: string): { name: string | null } | false {
  const m = BARE_GREETING.exec(
    sentence
      .trim()
      .replace(/[!.]+$/u, '')
      .trim(),
  )
  if (!m) return false
  const board = firstName(clientName)
  const words = [m[1], m[2]].filter((w): w is string => w !== undefined)
  if (words.some((w) => board === null || likeName(w) !== likeName(board))) return false
  return { name: words.length > 0 ? board : null }
}

const NOMINATIVE = {
  morning: 'доброе утро',
  day: 'добрый день',
  evening: 'добрый вечер',
} as const
const GENITIVE = { morning: 'доброго утра', day: 'доброго дня', evening: 'доброго вечера' } as const
const PART_NOMINATIVE = /(?<!\p{L})([Дд])обр(?:ый\s+день|ое\s+утро|ый\s+вечер)(?!\p{L})/u
const PART_GENITIVE = /(?<!\p{L})([Дд])оброго\s+(?:дня|утра|вечера)(?!\p{L})/u

/** A greeting of Boris's own that says more: its part of the day («Доброе утро, Ирина, спасибо!») follows the moment, the rest stays. */
function withPartOfDay(text: string, now: Date): string {
  const part = moscowPartOfDay(now)
  const first = FIRST_SENTENCE.exec(text)?.[0] ?? ''
  const cased = (d: string, phrase: string) => `${d === 'Д' ? 'Д' : 'д'}${phrase.slice(1)}`
  const fresh = first
    .replace(PART_NOMINATIVE, (_m, d: string) => cased(d, NOMINATIVE[part]))
    .replace(PART_GENITIVE, (_m, d: string) => cased(d, GENITIVE[part]))
  return `${fresh}${text.slice(first.length)}`
}

/**
 * The text of a bid as it goes out at `now` (rules 3, 4, 5, 8, 15): the greeting of that moment in Moscow, then the body
 * through the voice rules. The stored draft keeps the greeting it was made with; when its first sentence is a greeting
 * and no more, in any form («Ирина, добрый день!», «Здравствуйте, Ирина!»), that sentence is swapped for the fresh one
 * with the client's name. A first sentence that greets and says more, or names someone else, is Boris's own: its words
 * stay and only its part of the day («Доброе утро, Ирина, спасибо!») follows the moment. A text with no greeting gets
 * one with `clientName`. The card shows this text for its moment and the outbox sends it for its own.
 */
export function bidTextAt(stored: string, clientName: string, now: Date): string {
  return bidTextDetail(stored, clientName, now).text
}

/** What had to give way so that the bid fits the 500 characters: the client's name, or the part of the day. */
export type BidTextFallback = 'name_dropped' | 'greeting_kept'

/** `bidTextAt` with the note of what it had to give up; `fallback` is null for every draft made by this rule. */
export function bidTextDetail(
  stored: string,
  clientName: string,
  now: Date,
): { text: string; fallback: BidTextFallback | null } {
  const p = split(stored, clientName)
  if (p.own) {
    const text = p.at(now)
    return text.length <= BID_TEXT_MAX
      ? { text, fallback: null }
      : { text: p.kept, fallback: 'greeting_kept' }
  }
  const fresh = greeted(p.rest, p.name, now)
  if (fresh.length <= BID_TEXT_MAX) return { text: fresh, fallback: null }
  // Only a draft of before this rule can be here (500 characters with «добрый день», 501 with «добрый вечер»): the name
  // goes before the part of the day does, and the draft as it was before anything else.
  const nameless = greeted(p.rest, null, now)
  return nameless.length <= BID_TEXT_MAX
    ? { text: nameless, fallback: 'name_dropped' }
    : { text: p.kept, fallback: 'greeting_kept' }
}

/**
 * A stored draft taken apart: Boris's own greeting (its text for a moment), or the name of a bare greeting of ours and the
 * rest of the text. `kept` is the draft as it was, tidied.
 */
function split(
  stored: string,
  clientName: string,
):
  | { own: true; at: (now: Date) => string; kept: string }
  | { own: false; name: string | null; rest: string; kept: string } {
  const text = stored.replace(/\r\n?/g, '\n').trim()
  const first = FIRST_SENTENCE.exec(text)?.[0] ?? ''
  const bare = bareGreeting(first, clientName)
  const kept = plain(text)
  if (!bare && greets(text)) return { own: true, at: (now) => withPartOfDay(kept, now), kept }
  return {
    own: false,
    name: bare ? bare.name : clientName,
    rest: plain(bare ? text.slice(first.length) : text),
    kept,
  }
}

const greeted = (rest: string, name: string | null, now: Date): string => {
  const hello = greetingOf(name ?? '', now)
  return rest ? `${hello}\n\n${rest}` : hello
}

/**
 * The most characters a stored draft is when it goes out: its text with its own name at the worst hour of the day (the
 * evening greeting is the longest). The 500 characters of the form are held against this number, so a draft that fits
 * in the morning fits in the evening and nothing has to be cut at the moment of sending.
 */
export function bidLengthMax(stored: string, clientName: string): number {
  const p = split(stored, clientName)
  if (p.own) return Math.max(...PARTS_OF_DAY.map((t) => p.at(t).length))
  const { rest, name } = p
  return Math.max(...PARTS_OF_DAY.map((t) => greeted(rest, name, t).length))
}

/** The «Стоимость услуги»: never 0 and never above the client's budget (then the field stays empty). */
export function priceWithin(price: number | null, budgetText: string | null): number | null {
  if (!price) return null
  const sums = (budgetText ?? '').match(/\d[\d\s ]*/g)?.map((s) => Number(s.replace(/\D/g, '')))
  return sums && sums.length > 0 && price > Math.max(...sums) ? null : price
}

/**
 * The «до» of the range (Boris, 31.10.2026): the Analyst's own, not above the client's budget (the top of it when the
 * budget is a range), and above «от»; null when it is not (the program then puts half again over «от»).
 */
export function priceToWithin(
  from: number | null,
  to: number | null | undefined,
  budgetText: string | null,
): number | null {
  if (!from || !to) return null
  const sums = (budgetText ?? '')
    .match(/\d[\d\s\u00a0]*/g)
    ?.map((s) => Number(s.replace(/\D/g, '')))
  const top = sums && sums.length > 0 ? Math.max(...sums) : Number.POSITIVE_INFINITY
  const capped = Math.min(to, top)
  return capped > from ? capped : null
}

const PRICE_MAX = 10_000_000
const SUM = String.raw`(\d[\d  ]*)`
const RUB = String.raw`(?:₽|р\.?|руб\.?|рубл(?:ей|я|ь))`
/** «цена 5000», «Стоимость: 7 500 руб.», «Стоимость услуги 5000 ₽», on a line of its own. */
const PRICE_LINE = new RegExp(
  String.raw`^\s*(?:цена|стоимость(?:\s+услуги)?)\s*[:\-]?\s*${SUM}\s*${RUB}?\s*\.?\s*$`,
  'iu',
)
/** «5000 ₽» on a line of its own. */
const SUM_LINE = new RegExp(String.raw`^\s*${SUM}\s*${RUB}\s*\.?\s*$`, 'iu')
/** «30 000 - 60 000 ₽», «от 30 до 60 тыс.», «цена 30-60к» on a line of its own. */
const NUMBER = String.raw`\d[\d\s\u00a0]*(?:[.,]\d+)?`
const RANGE_LINE = new RegExp(
  String.raw`^\s*(?:(?:цена|стоимость(?:\s+услуги)?)\s*[:\-]?\s*)?(?:от\s+)?${NUMBER}\s*(?:-|–|до)\s*${NUMBER}\s*(?:(?:тыс(?:яч[а-я]*)?\.?|т\.?\s?р\.?|[кk])\s*)?(?:${RUB})?\s*\.?\s*$`,
  'iu',
)
/** A range line is a price only with a price word, a thousands mark or a currency: «10-12» alone is a date. */
const RANGE_MARK = /(цена|стоимост|тыс|₽|руб|р\.|\sр$|\d\s?[кk]\s*$)/iu
/** A bare «5000», only where the price was asked for. */
const BARE_LINE = new RegExp(String.raw`^\s*${SUM}\s*\.?\s*$`, 'u')

/**
 * Boris's price in his answer after «Изменить» (K2): the last line that is only a price, «цена 5000» or «5000 ₽» (a
 * bare number too when `bare`, the answer to the price question). It leaves the text; a sum inside a sentence stays
 * text. `text` is null when nothing but the price came.
 */
export function priceOf(
  answer: string,
  o: { bare?: boolean } = {},
): { text: string | null; priceRub: number | null; priceToRub: number | null } {
  const lines = answer.split('\n')
  const shapes = o.bare ? [PRICE_LINE, SUM_LINE, BARE_LINE] : [PRICE_LINE, SUM_LINE]
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    // A range («30 000 - 60 000», «от 30 до 60 тыс.») on a line of its own, with a price word or a currency mark.
    const range =
      RANGE_LINE.test(line) && (o.bare || RANGE_MARK.test(line)) ? parsePriceRange(line) : null
    const sum = range
      ? undefined
      : shapes.map((re) => re.exec(line)?.[1]).find((m) => m !== undefined)
    if (!range && sum === undefined) continue
    const rub = range ? range.from : Number((sum ?? '').replace(/\D/g, ''))
    // The price column is an int: a price past ten million is a slip, not a price.
    if (!Number.isSafeInteger(rub) || rub <= 0 || rub > PRICE_MAX) break
    const to = range?.to && range.to <= PRICE_MAX ? range.to : null
    const rest = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').trim()
    return { text: rest === '' ? null : rest, priceRub: rub, priceToRub: to }
  }
  return { text: answer.trim(), priceRub: null, priceToRub: null }
}

/** A message of the series is short: Boris's own were a line or three (growth-points, 29.10.2026). */
export const FOLLOW_UP_MAX = 300
/** Boris's own message of the series, edited on the pult: as long as he likes, within reason. */
export const FOLLOW_UP_EDIT_MAX = 500
/** The Analyst writes at most this many messages after a bid. */
export const FOLLOW_UPS_MAX = 2
/** With the message of links in front of them and the call offer after them, at most this many messages follow a bid. */
export const SERIES_MAX = FOLLOW_UPS_MAX + 3

/** Why a message of the series was left out. */
export type FollowUpMiss = 'not_plain' | 'greeting' | 'link' | 'too_long' | 'bad_case' | 'no_link'

/**
 * The series the model wrote, checked as a bid is (Boris, 29.10.2026): plain text, the voice rules, short, no greeting
 * (the bid greeted), no link of its own (the program puts a case's public link in), and a case only from the list, by
 * its rules of showing. A message that fails is left out with its reason; the bid stays whatever the series does.
 * The links of the cases shown go first, one message of their own, a link a line and each case once, and the words
 * follow it («Из недавнего)»): so Boris sent them (growth-points, 29.10.2026).
 */
export function followUpsOf(
  answer: AnalystOutput['follow_ups'],
  cases: CaseHit[],
  /** For an order of a site: the sites offered and the ids the answer chose; their links lead the message of links. */
  sites: { offered: HanceSite[]; ids: readonly string[] | undefined } = { offered: [], ids: [] },
  /** Links a client is never given (links.blocked): a case of the list is shown by no link. */
  blocked: readonly string[] = [],
): { texts: string[]; caseIds: string[]; siteIds: string[]; dropped: FollowUpMiss[] } {
  const texts: string[] = []
  const caseIds: string[] = []
  const links: string[] = []
  const dropped: FollowUpMiss[] = []
  for (const f of (answer ?? []).slice(0, FOLLOW_UPS_MAX)) {
    const text = plain(f.text).trim()
    const chosen = f.case_id ? (cases.find((c) => c.id === f.case_id) ?? null) : null
    const link = chosen ? publicLink(chosen, blocked) : null
    const miss: FollowUpMiss | null =
      !text || NOT_PLAIN.test(text) || BRACKETED.test(text)
        ? 'not_plain'
        : greets(text)
          ? 'greeting'
          : CASE_LINK.test(text)
            ? 'link'
            : text.length > FOLLOW_UP_MAX
              ? 'too_long'
              : bidCaseProblems(text, cases, chosen ? [chosen.id] : undefined).length > 0
                ? 'bad_case'
                : f.case_id && (!link || caseIds.includes(f.case_id))
                  ? 'no_link'
                  : null
    if (miss) {
      dropped.push(miss)
      continue
    }
    texts.push(text)
    if (chosen && link) {
      caseIds.push(chosen.id)
      links.push(link)
    }
  }
  // An order of a site shows 3-4 sites of Hance first (Boris, 30.10.2026); a case's link the sites have already is not
  // given twice, and the message holds no more links than the sites may.
  const shown = sites.offered.length > 0 ? chosenSites(sites.offered, sites.ids) : []
  const lines = [
    ...shown.map(siteLine),
    ...links.filter((l) => !shown.some((s) => sameUrl(s.url, l))),
  ].slice(0, shown.length > 0 ? SITES_SHOWN.max : links.length)
  return {
    texts: lines.length > 0 ? [lines.join('\n'), ...texts] : texts,
    caseIds,
    siteIds: shown.map((s) => s.id),
    dropped,
  }
}

/**
 * Boris's own series from the pult: the voice rules on each message, empty ones gone, at most three. Null when a
 * message is longer than a message of the series may be.
 */
export function followUpsEdit(texts: readonly string[]): string[] | null {
  const kept = texts.map((t) => plain(t).trim()).filter((t) => t !== '')
  if (kept.length > SERIES_MAX || kept.some((t) => t.length > FOLLOW_UP_EDIT_MAX)) return null
  return kept
}

/** How many words of a bid's first sentence make its opening (Boris, 29.10: five bids opened alike on 28.10). */
const OPENER_WORDS = 4

/** The opening of a bid body: its first words, lower case, no punctuation; «» for a body without words. */
export function openerOf(body: string): string {
  const words = bodyOf(body)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .match(/[\p{L}\p{N}]+/gu)
  return (words ?? []).slice(0, OPENER_WORDS).join(' ')
}

/** The first sentence of each bid, for the Analyst to see what it opened with lately; at most five, no repeats. */
export function recentOpenersText(bodies: readonly string[]): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const b of bodies) {
    const first = (/^[^.!?\n]*/u.exec(bodyOf(b))?.[0] ?? '').trim()
    const key = openerOf(first)
    if (!key || seen.has(key)) continue
    seen.add(key)
    lines.push(`«${first.length > 80 ? `${first.slice(0, 80)}…` : first}»`)
    if (lines.length === 5) break
  }
  return lines.length > 0
    ? `Последние отклики начинались так, начни этот по другому:\n${lines.join('\n')}`
    : ''
}

/** The client as the order page shows them, in one line without the name (ADR-016); null when it shows nothing. */
function clientLine(info: DraftSource['client_info']): string | null {
  if (!info) return null
  const parts = [
    info.on_profi_since,
    info.phone_verified === null || info.phone_verified === undefined
      ? null
      : info.phone_verified
        ? 'номер подтверждён'
        : 'номер не подтверждён',
    info.reviews &&
      `отзывы специалистов: ${info.reviews.positive} ${plural(info.reviews.positive, ['хороший', 'хороших', 'хороших'])}, ${info.reviews.negative} ${plural(info.reviews.negative, ['плохой', 'плохих', 'плохих'])}`,
    info.review_tags &&
      info.review_tags.length > 0 &&
      `отметки в отзывах: ${info.review_tags.join(', ')}`,
  ].filter((p): p is string => typeof p === 'string' && p !== '')
  return parts.length > 0 ? `Клиент на площадке: ${parts.join('; ')}` : null
}

/**
 * What the Analyst sees: the order as the Sorter sees it (no name, ADR-016), what the order page says about the
 * client, and the room left for the text.
 */
export function analystInput(o: DraftSource, maxBody: number, profileText = ''): string {
  return [
    sorterInput(o),
    clientLine(o.client_info),
    profileText === '' ? null : profileText,
    `Длина текста: не больше ${maxBody} знаков`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}

/** The least room the model keeps for the text of a bid, whatever the cases would take. */
const MIN_BODY = 150

const chars = (n: number) => `${n} ${plural(n, ['знак', 'знака', 'знаков'])}`

/**
 * The Analyst's draft with the code's greeting, at most 500 characters. A text too long or not plain is asked
 * for once more, saying why; a second miss, or no answer, gives no draft (the card then asks for «Изменить»).
 * The greeting is the one of `now` (the moment the draft is made), but the room is kept for the longest one of the day:
 * a bid is greeted again when it is sent, and the evening «добрый вечер» is a letter longer than the morning.
 */
export async function writeDraft(
  gw: Gateway,
  o: DraftSource,
  opts: {
    correlationId?: string
    causationId?: string
    profile?: ReplyProfile
    /** Cases of the mind that fit the order (Boris, 28.10.2026); the text may tell one of them. */
    mindCases?: CaseHit[]
    /** The texts of the latest bids, newest first: this one opens differently (Boris, 29.10.2026). */
    recentBids?: string[]
    /** For an order of a site, the sites of Hance it may show (Boris, 30.10.2026); none for any other order. */
    sites?: HanceSite[]
    /** Links a client is never given (links.blocked, Boris 30.10.2026). */
    blockedLinks?: string[]
    /** The client's own site as Sara read it (Boris, 30.10.2026); the text may name a detail of it. */
    site?: LeadSite | null
    now?: Date
  } = {},
): Promise<Draft | DraftMiss> {
  // The direction's own format and cases (FR-LEAD-6); with none the numbers and the input are what they always were.
  const profile: ReplyProfile = opts.profile ?? { reply_format: null, cases: [] }
  const ceiling = bidCeiling(profile)
  const now = opts.now ?? new Date()
  const longest = longestGreeting(o.client_name)
  // The model is told a shorter limit by the room the cases may take, but never under what a bid needs; a text
  // that fits the ceiling stays whole and the cases that do not fit are the ones left out.
  const bodyCeiling = ceiling - longest.length - 2
  const maxBody = Math.max(Math.min(MIN_BODY, bodyCeiling), bodyCeiling - caseReserve(profile))
  const mindCases = opts.mindCases ?? []
  const recent = opts.recentBids ?? []
  const extra = [
    analystProfileText(profile),
    bidCasesText(mindCases, opts.blockedLinks),
    sitesText(opts.sites ?? []),
    siteSection(opts.site),
    recentOpenersText(recent),
  ].filter((t) => t !== '')
  const base = analystInput(o, maxBody, extra.join('\n\n'))
  let input = base
  let reason: DraftMiss['reason'] = 'no_answer'
  let analysis: Analysis | null = null
  const redact = { names: namesToHide(o.client_name, o.client_info?.name) }
  // The program puts the links in: the model only named the ids, and only the library's count. They are fitted
  // behind the longest greeting of the day, so the bid fits whenever it is sent.
  const accept = (out: AnalystOutput, text: string, attempts: number): Draft => {
    const hello = greetingOf(o.client_name, now)
    // A case of the mind is told in the text itself, with no link: only its id is kept.
    const told = chosenCase(mindCases, out.case_ids)
    const placed = placeCases(`${longest}${text.slice(hello.length)}`, profile, out.case_ids ?? [])
    const series = followUpsOf(
      out.follow_ups,
      mindCases,
      { offered: opts.sites ?? [], ids: out.site_ids },
      opts.blockedLinks ?? [],
    )
    return {
      text: `${hello}${placed.text.slice(longest.length)}`,
      priceRub: priceWithin(out.price_rub, o.budget_text),
      priceToRub: priceToWithin(
        priceWithin(out.price_rub, o.budget_text),
        out.price_to_rub,
        o.budget_text,
      ),
      attempts,
      analysis: analysisOf(out),
      cases: told ? [...placed.shown, told.id] : placed.shown,
      followUps: series.texts,
      followUpCases: series.caseIds,
      followUpsDropped: series.dropped,
      ...(series.siteIds.length > 0 && { followUpSites: series.siteIds }),
    }
  }
  for (let attempts = 1; attempts <= 2; attempts++) {
    const {
      profile: _profile,
      now: _now,
      mindCases: _cases,
      recentBids: _recent,
      sites: _sites,
      blockedLinks: _blocked,
      site: _site,
      ...callOpts
    } = opts
    const r = await gw.call('analyst', input, AnalystOutput, { ...callOpts, redact })
    if (!r.ok) return { text: null, reason: 'no_answer', attempts, analysis }
    analysis = analysisOf(r.output)
    const body = bodyOf(plain(r.output.text))
    const text = draftOf(r.output.text, o.client_name, now)
    const longestLength = bidLengthMax(text, o.client_name)
    // Only a bid offered the mind's cases is checked for them; one without stays as it always was.
    const caseProblem =
      body && mindCases.length > 0
        ? bidCaseProblems(body, mindCases, r.output.case_ids)[0]
        : undefined
    if (!body || NOT_PLAIN.test(body)) {
      reason = 'not_plain'
      input = `${base}\n\nПрошлый вариант был не простой текст. Напиши только сам текст отклика, без JSON и разметки.`
    } else if (BRACKETED.test(body)) {
      reason = 'has_tag'
      input = `${base}\n\nВ прошлом варианте остались метки в квадратных скобках. Напиши текст без них, словами.`
    } else if (caseProblem) {
      reason = 'bad_case'
      input = `${base}\n\nВ прошлом варианте с кейсом что то не так: ${caseProblem}. Перепиши: кейс только из списка, по его правилам показа, или без кейса.`
    } else if (longestLength > ceiling) {
      reason = 'too_long'
      input = `${base}\n\nПрошлый вариант вышел ${chars(longestLength)} вместе с приветствием, а форма принимает не больше ${ceiling}. Напиши короче, не больше ${chars(maxBody)}, сохрани смысл и вопрос.`
    } else return accept(r.output, text, attempts)
  }
  return { text: null, reason, attempts: 2, analysis }
}
