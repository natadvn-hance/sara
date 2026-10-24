import type { CheckInput, CheckIssue } from '../types'
import {
  AI_PATTERNS,
  CALL_PROMISE_PATTERNS,
  CALL_WORD,
  GREETINGS,
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

// Digit runs that are not facts: phones, times, dates and list numbers. They are masked before numbers are read.
const SEP = '[ \\u00a0\\-]?'
const NOT_FACTS = [
  // +7 (918) 123-45-67, 8 918 123 45 67, 89181234567.
  new RegExp(
    `(?<![\\d+])(?:\\+7|8|7)${SEP}\\(?\\d{3,5}\\)?${SEP}\\d{1,3}${SEP}\\d{2}${SEP}\\d{2}(?!\\d)`,
    'g',
  ),
  // Another country: +375 29 123-45-67.
  new RegExp(
    `\\+(?!7)\\d{1,3}${SEP}\\(?\\d{2,4}\\)?${SEP}\\d{2,4}${SEP}\\d{2,4}(?:${SEP}\\d{2,4})?(?!\\d)`,
    'g',
  ),
  // 918 123-45-67 without the code, 123-45-67 in a city.
  new RegExp(`(?<!\\d)\\d{3}${SEP}\\d{3}${SEP}\\d{2}${SEP}\\d{2}(?!\\d)`, 'g'),
  /(?<![\d-])\d{2,3}-\d{2}-\d{2}(?![\d-])/g,
  /(?<!\d)\d{10,11}(?!\d)/g,
  /(?<!\d)\d{1,2}:\d{2}(?!\d)/g,
  // 25.10, 25.10.2026: a day and a month of two digits, so «2.5» stays a number.
  /(?<![\d.,])(?:0?[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])(?:\.(?:\d{4}|\d{2}))?(?![\d]|[.,]\d)/g,
  /(?<![\p{L}\d])в\s+\d{1,2}\s+(?:час(?:а|ов)?|утра|дня|вечера|ночи)(?!\p{L})/giu,
  // The number of a list line («1. Сайт»): robotic.list catches the list itself.
  /^[ \t]*\d{1,2}[.)](?=\s)/gm,
]

const NUMBER =
  /(?<![\p{L}\d.,])(?<!\p{L}-)(?:\d{1,3}(?:[ \u00a0\u202f\u2009]\d{3})+(?!\d)|\d+)(?:[.,]\d+)?%?/gu
const DASHES = /[\u2013\u2014]/
const THOUSANDS = /^\s*(?:тыс|т\.\s*р|к(?!\p{L}))/iu
const MILLIONS = /^\s*(?:млн|миллион)/iu

type Num = { shown: string; keys: string[] }

/** The numbers of a text that may be facts, each with the values it may stand for («50 тысяч» is 50 and 50000). */
function numbersIn(text: string): Num[] {
  let masked = text
  for (const re of NOT_FACTS) masked = masked.replace(re, (m) => ' '.repeat(m.length))
  const out: Num[] = []
  for (const m of masked.matchAll(NUMBER)) {
    const shown = m[0]
    const after = masked.slice(m.index + shown.length)
    const digits = shown.replace(/[^\d.,]/g, '').replace(',', '.')
    // A small number written into a word is a name, not a fact: 3D, 1С, 2-й.
    if (digits.length === 1 && /^-?\p{L}/u.test(after)) continue
    const value = Number(digits)
    const scale = THOUSANDS.test(after) ? 1000 : MILLIONS.test(after) ? 1_000_000 : 1
    out.push({ shown, keys: [...new Set([String(value), String(value * scale)])] })
  }
  return out
}

/** The numbers of a text as written: «50 000», «1,5», «30%»; never a phone, a clock time or a date. */
export function extractNumbers(text: string): string[] {
  return numbersIn(text).map((n) => n.shown)
}

const NAME = '(?:\\[имя \\d+\\]|[\\p{L}-]+(?:\\s+[\\p{L}-]+)?)'
const GREETING_START = new RegExp(
  `^\\s*(?:${NAME}\\s*,\\s*)?(?:${GREETINGS.join('|')})(?!\\p{L})`,
  'u',
)

/** Whether a reply opens with a greeting, maybe after the name and a comma: «Анна, здравствуйте». */
export function startsWithGreeting(text: string): boolean {
  return GREETING_START.test(fold(text))
}

const MOSCOW_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' })

/** Whether the last message from our side was on an earlier Moscow day (null: there was none). */
export function isNewMoscowDay(lastOursAt: string | null, now: Date): boolean {
  if (lastOursAt === null) return true
  const last = new Date(lastOursAt)
  if (Number.isNaN(last.getTime())) return true
  return MOSCOW_DAY.format(last) < MOSCOW_DAY.format(now)
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

  const allowed = new Set<string>()
  const sources = [...i.factIds.map((id) => i.knowledgeTexts[id] ?? ''), i.clientTurnText]
  for (const s of sources) for (const n of numbersIn(s)) for (const k of n.keys) allowed.add(k)
  const told = new Set<string>()
  for (const n of numbersIn(text)) {
    if (n.keys.some((k) => allowed.has(k)) || told.has(n.keys[0] ?? '')) continue
    told.add(n.keys[0] ?? '')
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
  for (const re of AI_PATTERNS) {
    const m = re.exec(folded)
    if (m) issues.push({ id: 'robotic.ai', detail: `слова про ИИ о себе: «${m[0]}»` })
  }
  if (/^\s*(?:\d+[.)]|[-•*])\s/m.test(text))
    issues.push({ id: 'robotic.list', detail: 'строки списком' })
  const markup = /\*\*|#|`/.exec(text)
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
  /(?<![\p{L}\d])в\s+\d{1,2}\s+(?:час(?:а|ов)?|утра|дня|вечера|ночи)(?!\p{L})/u,
]

function promiseIssues(text: string): CheckIssue[] {
  const issues: CheckIssue[] = []
  const folded = fold(text)
  for (const re of CALL_PROMISE_PATTERNS) {
    const m = re.exec(folded)
    if (m) issues.push({ id: 'promise.call', detail: `обещание звонка от себя: «${m[0]}»` })
  }
  for (const sentence of folded.split(/[.!?\n]+/)) {
    if (!CALL_WORD.test(sentence)) continue
    const time = CALL_TIMES.map((re) => re.exec(sentence)?.[0]).find(Boolean)
    if (time) issues.push({ id: 'promise.call', detail: `время звонка от себя: «${time}»` })
  }
  return issues
}

/** The code checks of a reply (FR-CONV-4, M4 design 5.6): every problem found, each with a reason Boris can read. */
export function checkReplyText(i: CheckInput): CheckIssue[] {
  const text = i.text?.trim() ?? ''
  // Without a text there is nothing to check: only a reply must have one.
  if (!text)
    return i.move === 'reply' ? [{ id: 'empty', detail: 'ход «ответить», а текста нет' }] : []
  return [
    ...factIssues(i, text),
    ...greetingIssues(i, text),
    ...(DASHES.test(text) ? [{ id: 'dash' as const, detail: 'длинное или среднее тире' }] : []),
    ...roboticIssues(i, text),
    ...promiseIssues(text),
  ]
}
