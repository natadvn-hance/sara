import type { CheckInput, CheckIssue } from '../types'
import { caseIssues, maskCaseName } from './caseChecks'
import {
  AI_NAME,
  AI_SELF_PATTERNS,
  CALL_DAY,
  CALL_PROMISE_PATTERNS,
  CALL_WORD,
  GREETINGS,
  NOT_NAMES,
  ROBOTIC_PHRASES,
} from './phrases'

const MAX_LENGTH = 600
/** A client turn longer than this may not be answered with more than LENGTH_TIMES its length. */
const SHORT_TURN = 40
const LENGTH_TIMES = 4
const REPEAT_WORDS = 8
const QUOTE_WORDS = 6

/** Lower case with ё as е: what every phrase and pattern is matched against. */
const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')
/** Folded words only, one space between them, with a space at each end. */
const plain = (s: string) =>
  ` ${fold(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `
const words = (s: string) => fold(s).match(/[\p{L}\p{N}]+/gu) ?? []

// Digit runs that are not plain counts: phones, times, dates and list numbers. They are cut out before numbers are
// read. In the client's words and in the records they are facts to be repeated; in Sara's reply a phone, a time or a
// date is allowed only when the client named it in this turn or the cited records hold it.
type Kind = 'phone' | 'time' | 'date'
type Mask = { kind: Kind | 'list'; re: RegExp; key: (m: string) => string }

const SEP = '[ \\u00a0\\-]?'
/** A word that says a number after it is a phone: a city number alone («10-15-20%» is a discount, not a phone). */
const PHONE_CONTEXT =
  '(?:тел\\p{L}*|т\\.|номер\\p{L}*|звон\\p{L}*|whatsapp|ватсап\\p{L}*|вотсап\\p{L}*|viber|вайбер\\p{L}*|telegram|телеграм\\p{L}*|моб\\p{L}*|сот\\p{L}*)'

/** A phone as 7 and ten digits, however its brackets and dashes stand. */
const phoneKey = (m: string) => {
  const d = m.replace(/\D/g, '')
  return d.length === 11 && d.startsWith('8') ? `7${d.slice(1)}` : d.length === 10 ? `7${d}` : d
}
const timeKey = (m: string) => m.replace(/^0/, '')
const dateKey = (m: string) => {
  const [d, mo] = m.split('.')
  return `${Number(d)}.${Number(mo)}`
}
const clockKey = (m: string) => `${Number(/\d+/.exec(m)?.[0])}:00`

/** The masks in order; `lenient` (the client's words, the records) also takes a bare city number as a phone. */
function masks(lenient: boolean): Mask[] {
  const cityPhone = lenient
    ? '(?<![\\d-])\\d{2,3}-\\d{2}-\\d{2}(?![\\d-])'
    : `(?<=${PHONE_CONTEXT}[^\\d\\n]{0,12})\\d{2,3}-\\d{2}-\\d{2}(?![\\d-])`
  return [
    // +7 (918) 123-45-67, 8 918 123 45 67, 89181234567.
    {
      kind: 'phone',
      re: new RegExp(
        `(?<![\\d+])(?:\\+7|8|7)${SEP}\\(?\\d{3,5}\\)?${SEP}\\d{1,3}${SEP}\\d{2}${SEP}\\d{2}(?!\\d)`,
        'g',
      ),
      key: phoneKey,
    },
    // Another country: +375 29 123-45-67.
    {
      kind: 'phone',
      re: new RegExp(
        `\\+(?!7)\\d{1,3}${SEP}\\(?\\d{2,4}\\)?${SEP}\\d{2,4}${SEP}\\d{2,4}(?:${SEP}\\d{2,4})?(?!\\d)`,
        'g',
      ),
      key: phoneKey,
    },
    // 918 123-45-67 without the code.
    {
      kind: 'phone',
      re: new RegExp(`(?<!\\d)\\d{3}${SEP}\\d{3}${SEP}\\d{2}${SEP}\\d{2}(?!\\d)`, 'g'),
      key: phoneKey,
    },
    { kind: 'phone', re: /(?<!\d)\d{10,11}(?!\d)/g, key: phoneKey },
    // 123-45-67 in a city: a phone only after a word about phones in a reply.
    { kind: 'phone', re: new RegExp(cityPhone, 'giu'), key: phoneKey },
    { kind: 'time', re: /(?<!\d)\d{1,2}:\d{2}(?!\d)/g, key: timeKey },
    // 25.10, 25.10.2026: a day and a month of two digits, so «2.5» stays a number.
    {
      kind: 'date',
      re: /(?<![\d.,])(?:0?[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])(?:\.(?:\d{4}|\d{2}))?(?![\d]|[.,]\d)/g,
      key: dateKey,
    },
    // «в 3 часа», «в 9 утра»; «в 3 дня» is also «за 3 дня» in a promise, so it is a plain number.
    {
      kind: 'time',
      re: /(?<![\p{L}\d])в\s+\d{1,2}\s+(?:час(?:а|ов)?|утра|вечера|ночи)(?!\p{L})/giu,
      key: clockKey,
    },
    // The number of a list line («1. Сайт»): robotic.list catches the list itself.
    { kind: 'list', re: /^[ \t]*\d{1,2}[.)](?=\s)/gm, key: () => '' },
  ]
}

type Found = { kind: Kind; shown: string; key: string }
const KIND_NAME: Record<Kind, string> = { phone: 'телефон', time: 'время', date: 'дата' }

/** The phones, times and dates of a text, and the text without them (their places left blank). */
function cutOut(text: string, lenient: boolean): { rest: string; found: Found[] } {
  let rest = text
  const found: Found[] = []
  for (const mask of masks(lenient))
    rest = rest.replace(mask.re, (m) => {
      if (mask.kind !== 'list') found.push({ kind: mask.kind, shown: m.trim(), key: mask.key(m) })
      return ' '.repeat(m.length)
    })
  return { rest, found }
}

const NUMBER =
  /(?<![\p{L}\d.,])(?<!\p{L}-)(?:\d{1,3}(?:[ \u00a0\u202f\u2009]\d{3})+(?!\d)|\d+)(?:[.,]\d+)?%?/gu
const DASHES = /[\u2013\u2014]/
const THOUSANDS = /^\s*(?:тыс|т\.\s*р|к(?!\p{L}))/iu
const MILLIONS = /^\s*(?:млн|миллион)/iu

type Num = { shown: string; key: string }

const PERCENT = /^\s*(?:%|проц)/iu
/** What stands between two numbers of a range: «50-70 тысяч», «от 50 до 70 тысяч». */
const RANGE = /^\s*(?:\p{Pd}|до|или)\s*$/iu

/**
 * The numbers of a text that may be facts. A number is keyed by its scaled value only («50 тысяч» is 50000, never
 * also 50), a percent keeps its sign («30%» is not 30), and a scale or percent at the end of a range belongs to the
 * number before it («50-70 тысяч», «от 50 до 70 тысяч»).
 */
function numbersIn(cutText: string): Num[] {
  // «топ-10», «x2», «2x» are a ranking and a multiplier, claims that need a source like any number, so they are
  // spaced out (same length) to be read; «3D», «B2B», «1С» stay names.
  const masked = cutText
    .replace(/(?<![\p{L}\d])(топ)-(?=\d)/giu, '$1 ')
    .replace(/(?<![\p{L}\d])[xх×](?=\d)/giu, ' ')
    .replace(/(?<=\d)[xх×](?![\p{L}\d])/giu, ' ')
  type Raw = {
    shown: string
    start: number
    end: number
    value: number
    scale: number | null
    percent: boolean
  }
  const raws: Raw[] = []
  for (const m of masked.matchAll(NUMBER)) {
    const shown = m[0]
    const end = m.index + shown.length
    const after = masked.slice(end)
    const digits = shown.replace(/[^\d.,]/g, '').replace(',', '.')
    // A small number written into a word is a name, not a fact: 3D, 1С, 2-й.
    if (digits.length === 1 && /^-?\p{L}/u.test(after)) continue
    raws.push({
      shown,
      start: m.index,
      end,
      value: Number(digits),
      scale: THOUSANDS.test(after) ? 1000 : MILLIONS.test(after) ? 1_000_000 : null,
      percent: shown.endsWith('%') || PERCENT.test(after),
    })
  }
  // Walk back so the scale of «70 тысяч» reaches «50» and, through «30-50-70 тысяч», every number of the range.
  for (let k = raws.length - 2; k >= 0; k--) {
    const here = raws[k]
    const next = raws[k + 1]
    if (!here || !next || here.scale !== null || here.percent) continue
    if (!RANGE.test(masked.slice(here.end, next.start))) continue
    here.scale = next.scale
    here.percent = next.percent
  }
  return raws.map((r) => {
    const value = Math.round(r.value * (r.scale ?? 1) * 1e6) / 1e6
    return { shown: r.shown, key: r.percent ? `${value}%` : String(value) }
  })
}

/** The numbers of a text as written: «50 000», «1,5», «30%»; never a phone, a clock time or a date. */
export function extractNumbers(text: string): string[] {
  return numbersIn(cutOut(text, true).rest).map((n) => n.shown)
}

const GREETING = new RegExp(`^(?:${GREETINGS.join('|')})(?!\\p{L})`, 'u')
/** A name before the greeting, as written: a capitalized word or two, or the tag the model was given. */
const NAME_FIRST = /^\s*(\[имя \d+\]|\p{Lu}[\p{L}-]*(?:\s+\p{Lu}[\p{L}-]*)?)\s*[,!.]?\s*/u

/**
 * Whether a reply opens with a greeting, maybe after the name: «Анна, здравствуйте», «Анна! Здравствуйте». A
 * capitalized opener that is not a name, «Понимаю, добрый день у вас был», is no name (the stoplist of NOT_NAMES).
 */
export function startsWithGreeting(text: string): boolean {
  if (GREETING.test(fold(text.trimStart()))) return true
  const name = NAME_FIRST.exec(text)
  if (!name) return false
  const first = fold(name[1] ?? '')
  if (!first.startsWith('[') && first.split(/\s+/).some((w) => NOT_NAMES.has(w))) return false
  return GREETING.test(fold(text.slice(name[0].length)))
}

const MOSCOW_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
})

/** The Moscow calendar day of a moment as a number that orders by date (20261025). */
function moscowDay(d: Date): number {
  const part = (type: string) =>
    Number(MOSCOW_DATE.formatToParts(d).find((p) => p.type === type)?.value)
  return part('year') * 10_000 + part('month') * 100 + part('day')
}

/** Whether the last message from our side was on an earlier Moscow day (null: there was none). */
export function isNewMoscowDay(lastOursAt: string | null, now: Date): boolean {
  if (lastOursAt === null) return true
  const last = new Date(lastOursAt)
  if (Number.isNaN(last.getTime())) return true
  return moscowDay(last) < moscowDay(now)
}

/** The first run of `n` words of `text` that also stands in one of `sources`, joined by spaces. */
function sharedRun(text: string, sources: string[], n: number): string | null {
  const known = new Set<string>()
  for (const s of sources) {
    const w = words(s)
    for (let k = 0; k + n <= w.length; k++) known.add(w.slice(k, k + n).join(' '))
  }
  const w = words(text)
  for (let k = 0; k + n <= w.length; k++) {
    const run = w.slice(k, k + n).join(' ')
    if (known.has(run)) return run
  }
  return null
}

function factIssues(i: CheckInput, text: string): CheckIssue[] {
  const issues: CheckIssue[] = []
  const recalled = new Set(i.recalledIds)
  for (const id of new Set(i.factIds))
    if (!recalled.has(id))
      issues.push({ id: 'facts.unknown', detail: `номер ${id} не из отобранных записей` })
  if (i.factIds.length === 0)
    issues.push({ id: 'facts.none', detail: 'в ответе нет ни одного номера записи разума' })

  // What the reply may say: the numbers, phones, times and dates of the cited records and of the client's turn.
  const allowed = new Set<string>()
  const allowedTokens = new Set<string>()
  const sources = [...i.factIds.map((id) => i.knowledgeTexts[id] ?? ''), i.clientTurnText]
  // The numbers of the case the reply tells are its own, when the show rules open them (case.closed checks the rest).
  const chosen = i.cases?.choice?.case_id
    ? i.cases.offered.find((o) => o.id === i.cases?.choice?.case_id)
    : undefined
  if (chosen?.numbersOpen) sources.push(`${chosen.summary}\n${chosen.result ?? ''}`)
  for (const s of sources) {
    const { rest, found } = cutOut(s, true)
    for (const n of numbersIn(rest)) allowed.add(n.key)
    for (const f of found) {
      allowedTokens.add(`${f.kind}:${f.key}`)
      // «9:00» in a record also lets «с 9 до 18» through; «27.10» lets «27 октября».
      for (const part of f.kind === 'phone' ? [] : f.key.split(/[.:]/))
        if (Number(part) > 0) allowed.add(String(Number(part)))
    }
  }
  const told = new Set<string>()
  // «7.10» of «Боулинг-клуб 7.10» is a name, not a date: blanked out when the chosen case may be named.
  const { rest, found } = cutOut(chosen?.nameOpen ? maskCaseName(text, chosen.title) : text, false)
  for (const f of found) {
    const token = `${f.kind}:${f.key}`
    if (allowedTokens.has(token) || told.has(token)) continue
    told.add(token)
    issues.push({ id: 'facts.numbers', detail: `${KIND_NAME[f.kind]} ${f.shown} не из разума` })
  }
  for (const n of numbersIn(rest)) {
    if (allowed.has(n.key) || told.has(n.key)) continue
    told.add(n.key)
    issues.push({ id: 'facts.numbers', detail: `число ${n.shown} не из разума` })
  }
  return issues
}

function greetingIssues(i: CheckInput, text: string): CheckIssue[] {
  const greets = startsWithGreeting(text)
  if (i.newDay && !greets)
    return [{ id: 'greeting.missing', detail: 'нет приветствия, а сегодня новый день' }]
  if (!i.newDay && greets)
    return [{ id: 'greeting.extra', detail: 'снова приветствие, а сегодня уже здоровались' }]
  return []
}

function roboticIssues(i: CheckInput, text: string): CheckIssue[] {
  const issues: CheckIssue[] = []
  const folded = fold(text)
  const flat = plain(text)
  for (const phrase of [...ROBOTIC_PHRASES, ...i.bannedPhrases]) {
    const p = plain(phrase)
    if (p.trim() && flat.includes(p))
      issues.push({ id: 'robotic.phrase', detail: `роботная фраза «${phrase.trim()}»` })
  }
  // One issue however many words: «Я бот» and «пишет бот» are the same fault.
  const named = AI_NAME.exec(folded)?.[0]
  const ai =
    AI_SELF_PATTERNS.map((re) => re.exec(folded)?.[0]).find(Boolean) ??
    (named && !fold(i.clientTurnText).includes(named) ? named : null)
  if (ai) issues.push({ id: 'robotic.ai', detail: `слова про ИИ о себе: «${ai}»` })
  if (/^\s*(?:\d+[.)]|[-•*])\s/m.test(text))
    issues.push({ id: 'robotic.list', detail: 'строки списком' })
  // Bold, a heading at the start of a line or code; «#кофейня» is a hashtag, not markup.
  const markup = /\*\*|^#{1,6}\s|`/m.exec(text)
  if (markup) issues.push({ id: 'robotic.markup', detail: `разметка: ${markup[0]}` })

  const turn = i.clientTurnText.trim().length
  if (text.length > MAX_LENGTH)
    issues.push({
      id: 'robotic.length',
      detail: `длина ответа ${text.length}, а можно до ${MAX_LENGTH}`,
    })
  else if (turn > SHORT_TURN && text.length > LENGTH_TIMES * turn)
    issues.push({
      id: 'robotic.length',
      detail: `длина ответа ${text.length}, больше четырёх длин реплики клиента (${turn})`,
    })

  const repeat = sharedRun(text, i.ourPrevious, REPEAT_WORDS)
  if (repeat)
    issues.push({ id: 'robotic.repeat', detail: `повтор прошлого сообщения: «${repeat}»` })
  const quote = sharedRun(text, [i.clientTurnText], QUOTE_WORDS)
  if (quote) issues.push({ id: 'robotic.quote', detail: `дословно из слов клиента: «${quote}»` })
  return issues
}

const CALL_TIMES = [
  /(?<!\d)\d{1,2}:\d{2}(?!\d)/u,
  // Not «в 3 дня»: «сделаем в 3 дня» is a term, and a sentence about a call may name one.
  /(?<![\p{L}\d])в\s+\d{1,2}\s+(?:час(?:а|ов)?|утра|вечера|ночи)(?!\p{L})/u,
]

/** At most one issue: a call promised by Sara or by Boris through her, or a day or an hour she picks for a call. */
function promiseIssues(text: string): CheckIssue[] {
  const folded = fold(text)
  for (const re of CALL_PROMISE_PATTERNS) {
    const m = re.exec(folded)
    if (m) return [{ id: 'promise.call', detail: `обещание звонка от себя: «${m[0]}»` }]
  }
  for (const sentence of folded.split(/[.!?\n]+/)) {
    if (!CALL_WORD.test(sentence)) continue
    const when = [...CALL_TIMES, CALL_DAY].map((re) => re.exec(sentence)?.[0]).find(Boolean)
    if (when) return [{ id: 'promise.call', detail: `время звонка от себя: «${when}»` }]
  }
  return []
}

/** The numbers of a text as keys («50 тысяч» is 50000), phones, times and dates left out. */
const numberKeys = (s: string): Set<string> =>
  new Set(numbersIn(cutOut(s, true).rest).map((n) => n.key))

/** The code checks of a reply (FR-CONV-4, M4 design 5.6): every problem found, each with a reason Boris can read. */
export function checkReplyText(i: CheckInput): CheckIssue[] {
  const text = i.text?.trim() ?? ''
  // Only a reply is sent to the client, so only a reply is checked and must have a text.
  if (i.move !== 'reply') return []
  if (!text) return [{ id: 'empty', detail: 'ход «ответить», а текста нет' }]
  return [
    ...factIssues(i, text),
    ...greetingIssues(i, text),
    ...(DASHES.test(text) ? [{ id: 'dash' as const, detail: 'длинное или среднее тире' }] : []),
    ...roboticIssues(i, text),
    ...promiseIssues(text),
    ...caseIssues(i, text, numberKeys),
  ]
}
