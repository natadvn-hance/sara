import { formatRub, priceRange } from '@sara/shared'

/**
 * The posts of a client's topic, written so that the topic reads like the chat with him (Boris, 01.11: «имитация
 * чата», «по времени и датам непонятно вообще что происходит»). Every post says who and when, with a real date and
 * time, because Telegram's own time is the time of the posting and a topic restored later would lie. Telegram HTML,
 * every value escaped. No long dash (NFR-UX-1).
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const hyphen = (s: string) => esc(s.replace(/[—–]/g, '-'))

const MONTHS = [
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

/** «28 октября, 15:39» in Moscow; the year only when it is not this one. */
export function stamp(at: string | Date, now: Date = new Date()): string {
  const t = new Date(typeof at === 'string' ? at : at.getTime())
  const m = new Date(t.getTime() + 3 * 3600_000)
  const n = new Date(now.getTime() + 3 * 3600_000)
  const hh = String(m.getUTCHours()).padStart(2, '0')
  const mm = String(m.getUTCMinutes()).padStart(2, '0')
  const year = m.getUTCFullYear() === n.getUTCFullYear() ? '' : ` ${m.getUTCFullYear()}`
  return `${m.getUTCDate()} ${MONTHS[m.getUTCMonth()]}${year}, ${hh}:${mm}`
}

const quote = (text: string) => `<blockquote>${hyphen(text.trim())}</blockquote>`

/** What the client wrote. */
export function clientPost(o: { name: string | null; at: string; text: string }): string {
  return `💬 <b>${hyphen(o.name || 'Клиент')}</b> · ${stamp(o.at)}\n${quote(o.text)}`
}

/** What our side wrote in the chat (the signature is «Вы», the account is Boris's). */
export function ourPost(o: { at: string; text: string }): string {
  return `↗️ <b>Вы</b> · ${stamp(o.at)}\n${quote(o.text)}`
}

/** The bid: when it went, the fee, the range of the service and the text that really went. */
export function bidPost(o: {
  at: string
  text: string | null
  feeRub: number | null
  priceFromRub: number | null
  priceToRub: number | null
}): string {
  const money = [
    o.feeRub && o.feeRub > 0 ? `Отклик: ${formatRub(o.feeRub)}` : null,
    o.priceFromRub
      ? (() => {
          const r = priceRange(o.priceFromRub, o.priceToRub)
          return `Услуга: от ${formatRub(r.from)} до ${formatRub(r.to)}`
        })()
      : null,
  ].filter(Boolean)
  return [
    `📨 <b>Отклик отправлен</b> · ${stamp(o.at)}`,
    o.text?.trim() ? quote(o.text) : null,
    money.length ? money.join(' · ') : null,
  ]
    .filter(Boolean)
    .join('\n')
}

/** A message that followed the bid. */
export function seriesPost(o: { at: string; text: string; n: number; total: number }): string {
  return `✉️ <b>Вдогонку ${o.n} из ${o.total}</b> · ${stamp(o.at)}\n${quote(o.text)}`
}

/** The line before restored history. */
export function restoredNote(): string {
  return '📜 <i>Тема открыта позже. Ниже переписка за прошлые дни, у каждого сообщения его настоящие дата и время.</i>'
}

/** A small quiet step of the talk («прочитал», «созвон»), second to the posts above. */
export function stepPost(text: string, at: string): string {
  return `<i>${hyphen(text)} · ${stamp(at)}</i>`
}

const URL_WORDS = 'Открыть заказ на Профи.ру'

/** The first post of a topic: what the order is, laid out. */
export function introPost(o: {
  title: string | null
  orderId: string | null
  clientName: string | null
  city: string | null
  budget: string | null
  seenAt: string | null
  text: string | null
}): string {
  const head = `📌 <b>${hyphen(o.title ?? (o.orderId ? `Заказ №${o.orderId}` : 'Клиент без заказа'))}</b>`
  const who = [o.clientName, o.city, o.budget ? `бюджет ${o.budget}` : null]
    .filter(Boolean)
    .map((x) => hyphen(String(x)))
    .join(' · ')
  const raw = (o.text ?? '').replace(/\r\n?/g, '\n').trim()
  const parts = raw
    .split(/\s·\s|\n+/u)
    .map((p) => p.trim())
    .filter(Boolean)
  const [request, ...facts] = parts
  const full = raw.replace(/\s+/g, ' ')
  const lines = [
    head,
    who || null,
    o.seenAt ? `Заявка от ${stamp(o.seenAt)}` : null,
    request ? `\n${hyphen(request.length > 300 ? `${request.slice(0, 299)}…` : request)}` : null,
    facts.length
      ? facts
          .slice(0, 8)
          .map((f) => `• ${hyphen(f.length > 160 ? `${f.slice(0, 159)}…` : f)}`)
          .join('\n')
      : null,
    full.length > 400 ? `<blockquote expandable>${hyphen(full.slice(0, 3000))}</blockquote>` : null,
    o.orderId
      ? `\n<a href="https://profi.ru/backoffice/n.php?o=${encodeURIComponent(o.orderId)}">${URL_WORDS}</a>`
      : null,
    '\n<i>Здесь всё по этому клиенту. Напиши сюда текст, и я предложу отправить его клиенту.</i>',
  ]
  return lines.filter((l) => l !== null).join('\n')
}
