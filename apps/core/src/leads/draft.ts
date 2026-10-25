import { AnalystOutput, type ClientInfo, type ProfiOrder, plural } from '@sara/shared'
import type { Gateway } from '../gateway/gateway'
import { firstName, namesToHide } from './clientName'
import { repostedLine, sorterInput } from './sorter'

/** Profi.ru's bid form takes at most this many characters, the greeting included. */
export const BID_TEXT_MAX = 500

/**
 * What a draft is written from; the client's name only ever reaches the greeting, never the model: the gateway
 * hides it, the board's and the order page's, wherever the text says it.
 */
export type DraftSource = Pick<
  ProfiOrder,
  | 'title'
  | 'category'
  | 'city'
  | 'budget_text'
  | 'text'
  | 'client_name'
  | 'reposted'
  | 'repost_notice'
> & {
  /** What the order page says about the client; absent when the page was not read. Its name is only hidden from the model, never sent (ADR-016). */
  client_info?: (Pick<ClientInfo, 'name'> & Partial<ClientInfo>) | null
}

/** The Analyst's reading of the order and its short разбор, kept beside the draft. */
export type Analysis = Pick<AnalystOutput, 'reading' | 'hidden_need' | 'risk' | 'condition'>
export type Draft = {
  text: string
  priceRub: number | null
  attempts: number
  analysis: Analysis
}
/** No text to send; a reading the model did give stays (its text was too long or not plain). */
export type DraftMiss = {
  text: null
  reason: 'no_answer' | 'too_long' | 'not_plain' | 'has_tag'
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
const DASHES = /[\u2013\u2014]/g
/** The model's own framing or JSON around the text (old Sara, 17.09 and 30.09): never typed into the form. */
const NOT_PLAIN = /^\s*[{[]|<\/?parameter\b/i
/**
 * A word in square brackets: a tag of ADR-016 the model made up and the gateway could not put back («[имя 4]»,
 * «[Имя]», «[ссылка на сайт]»). A bid has no use for brackets, and the client would read them.
 */
const BRACKETED = /\[[^\]\n]{1,40}\]/u

/** «Ирина, добрый день!» when the client's name is known, else «Добрый день!» (Boris, 20.10: a missing hello is rude). */
export function greetingOf(clientName: string): string {
  const name = firstName(clientName)
  return name ? `${name}, добрый день!` : 'Добрый день!'
}

export function greets(text: string): boolean {
  return OPENING_GREETING.test(text.trim())
}

/** The text without its opening greeting sentence. */
export function bodyOf(text: string): string {
  const t = text.trim()
  return greets(t) ? t.replace(FIRST_SENTENCE, '').trim() : t
}

const plain = (s: string) => s.replace(DASHES, '-').trim()

/** The model's body behind the code's greeting; a greeting the model wrote anyway goes, it never knows the name. */
export function draftOf(body: string, clientName: string): string {
  return `${greetingOf(clientName)}\n\n${bodyOf(plain(body))}`
}

/** Boris's own text: his greeting stays; without one ours goes first (a bare «Ирина,» at the start joins it). */
export function editOf(text: string, clientName: string): string {
  const t = plain(text)
  if (greets(t)) return t
  const name = firstName(clientName)
  const rest = name ? t.replace(new RegExp(`^${name},\\s*`, 'iu'), '') : t
  return `${greetingOf(clientName)}\n\n${rest.charAt(0).toUpperCase()}${rest.slice(1)}`
}

/** The «Стоимость услуги»: never 0 and never above the client's budget (then the field stays empty). */
export function priceWithin(price: number | null, budgetText: string | null): number | null {
  if (!price) return null
  const sums = (budgetText ?? '').match(/\d[\d\s ]*/g)?.map((s) => Number(s.replace(/\D/g, '')))
  return sums && sums.length > 0 && price > Math.max(...sums) ? null : price
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
): { text: string | null; priceRub: number | null } {
  const lines = answer.split('\n')
  const shapes = o.bare ? [PRICE_LINE, SUM_LINE, BARE_LINE] : [PRICE_LINE, SUM_LINE]
  for (let i = lines.length - 1; i >= 0; i--) {
    const sum = shapes.map((re) => re.exec(lines[i] ?? '')?.[1]).find((m) => m !== undefined)
    if (sum === undefined) continue
    const rub = Number(sum.replace(/\D/g, ''))
    // The price column is an int: a price past ten million is a slip, not a price.
    if (!Number.isSafeInteger(rub) || rub <= 0 || rub > PRICE_MAX) break
    const rest = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').trim()
    return { text: rest === '' ? null : rest, priceRub: rub }
  }
  return { text: answer.trim(), priceRub: null }
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
export function analystInput(o: DraftSource, maxBody: number): string {
  return [
    repostedLine(o),
    sorterInput(o),
    clientLine(o.client_info),
    `Длина текста: не больше ${maxBody} знаков`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}

const chars = (n: number) => `${n} ${plural(n, ['знак', 'знака', 'знаков'])}`

/**
 * The Analyst's draft with the code's greeting, at most 500 characters. A text too long or not plain is asked
 * for once more, saying why; a second miss, or no answer, gives no draft (the card then asks for «Изменить»).
 */
export async function writeDraft(
  gw: Gateway,
  o: DraftSource,
  opts: { correlationId?: string; causationId?: string } = {},
): Promise<Draft | DraftMiss> {
  const greeting = greetingOf(o.client_name)
  const maxBody = BID_TEXT_MAX - greeting.length - 2
  const base = analystInput(o, maxBody)
  let input = base
  let reason: DraftMiss['reason'] = 'no_answer'
  let analysis: Analysis | null = null
  const redact = { names: namesToHide(o.client_name, o.client_info?.name) }
  for (let attempts = 1; attempts <= 2; attempts++) {
    const r = await gw.call('analyst', input, AnalystOutput, { ...opts, redact })
    if (!r.ok) return { text: null, reason: 'no_answer', attempts, analysis }
    analysis = analysisOf(r.output)
    const body = bodyOf(plain(r.output.text))
    const text = draftOf(r.output.text, o.client_name)
    if (!body || NOT_PLAIN.test(body)) {
      reason = 'not_plain'
      input = `${base}\n\nПрошлый вариант был не простой текст. Напиши только сам текст отклика, без JSON и разметки.`
    } else if (BRACKETED.test(body)) {
      reason = 'has_tag'
      input = `${base}\n\nВ прошлом варианте остались метки в квадратных скобках. Напиши текст без них, словами.`
    } else if (text.length > BID_TEXT_MAX) {
      reason = 'too_long'
      input = `${base}\n\nПрошлый вариант вышел ${chars(text.length)} вместе с приветствием, а форма принимает не больше ${BID_TEXT_MAX}. Напиши короче, не больше ${chars(maxBody)}, сохрани смысл и вопрос.`
    } else {
      return {
        text,
        priceRub: priceWithin(r.output.price_rub, o.budget_text),
        attempts,
        analysis,
      }
    }
  }
  return { text: null, reason, attempts: 2, analysis }
}
