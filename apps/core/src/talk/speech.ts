/**
 * Sara's text answer as words for her voice (ADR-028). Silero reads Cyrillic letters only, so the numbers become words
 * (money, percents, times and dates the way a person says them), links and marks go, Latin words are said in Cyrillic.
 * What is said is cut at a sentence: a long answer is for the eyes, the voice tells the start and points to the text.
 */

const ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const TEENS = [
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
]
const TENS = [
  '',
  '',
  'двадцать',
  'тридцать',
  'сорок',
  'пятьдесят',
  'шестьдесят',
  'семьдесят',
  'восемьдесят',
  'девяносто',
]
const HUNDREDS = [
  '',
  'сто',
  'двести',
  'триста',
  'четыреста',
  'пятьсот',
  'шестьсот',
  'семьсот',
  'восемьсот',
  'девятьсот',
]
const DIGITS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']

/** The form after a number: 1 рубль, 2 рубля, 5 рублей. */
export function plural(n: number, forms: [string, string, string]): string {
  const ten = n % 10
  const hundred = n % 100
  if (ten === 1 && hundred !== 11) return forms[0]
  if (ten >= 2 && ten <= 4 && (hundred < 10 || hundred >= 20)) return forms[1]
  return forms[2]
}

function triple(n: number, feminine: boolean): string[] {
  const words: string[] = []
  const h = Math.floor(n / 100)
  const rest = n % 100
  if (h) words.push(HUNDREDS[h] as string)
  if (rest >= 10 && rest < 20) words.push(TEENS[rest - 10] as string)
  else {
    if (rest >= 20) words.push(TENS[Math.floor(rest / 10)] as string)
    const one = rest % 10
    if (one) words.push((feminine ? ONES_F : ONES_M)[one] as string)
  }
  return words
}

const SCALES: { size: number; feminine: boolean; forms: [string, string, string] }[] = [
  { size: 1e9, feminine: false, forms: ['миллиард', 'миллиарда', 'миллиардов'] },
  { size: 1e6, feminine: false, forms: ['миллион', 'миллиона', 'миллионов'] },
  { size: 1e3, feminine: true, forms: ['тысяча', 'тысячи', 'тысяч'] },
]

/** A whole number in words, masculine: 1250 is «тысяча двести пятьдесят». */
export function cardinal(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n === 0) return 'ноль'
  const words: string[] = []
  let rest = Math.floor(n)
  for (const s of SCALES) {
    const part = Math.floor(rest / s.size)
    rest %= s.size
    if (!part) continue
    // «тысяча», «миллион» alone, not «одна тысяча».
    if (part !== 1) words.push(...triple(part, s.feminine))
    words.push(plural(part, s.forms))
  }
  words.push(...triple(rest, false))
  return words.join(' ')
}

const ORDINAL_GEN = [
  '',
  'первого',
  'второго',
  'третьего',
  'четвёртого',
  'пятого',
  'шестого',
  'седьмого',
  'восьмого',
  'девятого',
  'десятого',
  'одиннадцатого',
  'двенадцатого',
  'тринадцатого',
  'четырнадцатого',
  'пятнадцатого',
  'шестнадцатого',
  'семнадцатого',
  'восемнадцатого',
  'девятнадцатого',
  'двадцатого',
]
const MONTHS_GEN = [
  '',
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
]

function dayOrdinal(d: number): string {
  if (d <= 20) return ORDINAL_GEN[d] as string
  if (d < 30) return `двадцать ${ORDINAL_GEN[d - 20]}`
  return d === 30 ? 'тридцатого' : 'тридцать первого'
}

/** Words of Latin letters Boris and Sara use, as they are said. */
const LATIN_WORDS: Record<string, string> = {
  hance: 'Ханс',
  telegram: 'Телеграм',
  claude: 'Клод',
  opus: 'Опус',
  profi: 'Профи',
  ok: 'окей',
  seo: 'сео',
  crm: 'си ар эм',
  mini: 'мини',
  app: 'апп',
  google: 'гугл',
  yandex: 'яндекс',
  whatsapp: 'вотсап',
  pdf: 'пэ дэ эф',
}
const LATIN_LETTERS: Record<string, string> = {
  a: 'а',
  b: 'б',
  c: 'к',
  d: 'д',
  e: 'е',
  f: 'ф',
  g: 'г',
  h: 'х',
  i: 'и',
  j: 'дж',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  q: 'к',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  v: 'в',
  w: 'в',
  x: 'кс',
  y: 'й',
  z: 'з',
}

function cyrillic(word: string): string {
  const known = LATIN_WORDS[word.toLowerCase()]
  const said = known ?? [...word.toLowerCase()].map((ch) => LATIN_LETTERS[ch] ?? '').join('')
  // A name (Hance, Telegram) keeps its capital; letters of an abbreviation (OK, SEO) are a plain word.
  return /^[A-Z][a-z]/.test(word) ? said.charAt(0).toUpperCase() + said.slice(1) : said
}

/** A number written with spaces between thousands («1 250») or without. */
const NUM = String.raw`\d{1,3}(?:[   ]\d{3})+|\d+`
const toInt = (s: string) => Number(s.replace(/[   ]/g, ''))

const SPEECH_MAX = 900
const SPEAKABLE = /[^А-Яа-яЁё\s.,!?:;\-()«»"'…+]/g

/** Sara's answer as the words her voice says. */
export function speakableText(text: string): string {
  let links = false
  let t = text.replace(
    /\bhttps?:\/\/\S+|\bwww\.\S+|\b[\w-]+\.(?:ru|pro|com|io)(?:\/\S*)?/gi,
    () => {
      links = true
      return ' '
    },
  )
  // Markdown and list marks; every line is its own sentence.
  t = t
    .replace(/\*\*|__|`+/g, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, '')
        .trim()
        .replace(/[:;,]+$/, ''),
    )
    .filter((line) => /[\p{L}\d]/u.test(line))
    .map((line) => (/[.!?…]$/.test(line) ? line : `${line}.`))
    .join(' ')
  t = t
    .replace(/№\s*/g, 'номер ')
    // dates first: 07.11, 7.11 or 07.11.2026 (the year is left to the text); «1.5 часа» is a number, not a date
    .replace(/\b(\d{1,2})\.(\d{2})(?:\.\d{2,4})?\b/g, (all, d: string, m: string) => {
      const day = Number(d)
      const month = Number(m)
      return day >= 1 && day <= 31 && month >= 1 && month <= 12
        ? `${dayOrdinal(day)} ${MONTHS_GEN[month]}`
        : all
    })
    // times: 15:30, 09:05
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_all, h: string, m: string) => {
      const minutes = Number(m)
      const tail =
        minutes === 0 ? 'ноль ноль' : minutes < 10 ? `ноль ${cardinal(minutes)}` : cardinal(minutes)
      return `${cardinal(Number(h))} ${tail}`
    })
    .replace(new RegExp(`(${NUM})\\s*(?:₽|руб\\.?|рублей|рубля|рубль)`, 'g'), (_all, n: string) => {
      const v = toInt(n)
      return `${cardinal(v)} ${plural(v, ['рубль', 'рубля', 'рублей'])}`
    })
    .replace(new RegExp(`(${NUM})\\s*%`, 'g'), (_all, n: string) => {
      const v = toInt(n)
      return `${cardinal(v)} ${plural(v, ['процент', 'процента', 'процентов'])}`
    })
    // numbers of orders, phones and such: digit by digit
    .replace(/\d{6,}/g, (n) => ` ${[...n].map((c) => DIGITS[Number(c)]).join(' ')} `)
    .replace(
      /(\d+)[.,](\d+)/g,
      (_all, a: string, b: string) => `${cardinal(Number(a))} и ${cardinal(Number(b))}`,
    )
    .replace(new RegExp(NUM, 'g'), (n) => cardinal(toInt(n)))
    .replace(/[A-Za-z]+/g, cyrillic)
    .replace(/(\S)-(\s)/g, '$1 -$2')
    .replace(SPEAKABLE, ' ')
    .replace(/\s+([.,!?:;…])/g, '$1')
    .replace(/([.!?…])(?:\s*[.,:;])+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > SPEECH_MAX) {
    const cut = t.slice(0, SPEECH_MAX)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    t = `${end > 0 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}.`} Остальное в тексте.`
  }
  if (links) t = `${t} Ссылки в тексте.`.trim()
  return t
}
