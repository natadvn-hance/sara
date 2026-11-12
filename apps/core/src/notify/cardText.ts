import { formatRub, isTestOrder, priceRange } from '@sara/shared'
import { isCallOffer, SLOTS_MARK } from '../leads/callSlots'
import { firstName } from '../leads/clientName'
import { isTelegramLine } from '../leads/telegramLine'
import type { CardState } from './cardState'
import { esc, type LeadCard, MESSAGE_LIMIT, orderUrl, telegramTextLength } from './cards'

/**
 * The text under a picture card (FR-NOTIF-6, 12.11.2026): what is long and may be copied goes as Telegram text, the
 * picture above it keeps only the main. A new card: the client's words, the bid and its series, each folded in an
 * expandable quote, within one message; a later state: one sentence of what happened.
 */

const DASHES = /[\u2013\u2014]/g
/** A little under Telegram's limit, so the plain text of the same message fits too when it refuses the markup. */
const FIT = MESSAGE_LIMIT - 100

/** `s` cut after a whole word to at most `max` characters, its paragraphs kept, with «…». */
function cut(s: string, max: number): string {
  const t = s
    .replace(DASHES, '-')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (t.length <= max) return t
  const head = t.slice(0, max - 1)
  const space = head.search(/\s\S{0,25}$/)
  return `${(space > 0 ? head.slice(0, space) : head).replace(/[\s,.;:]+$/, '')}…`
}

const quote = (t: string) => `<blockquote expandable>${esc(t)}</blockquote>`

/** The state of a short card in one sentence. */
function stateText(st: CardState): string {
  switch (st.s) {
    case 'sending':
      return 'Отправляю отклик…'
    case 'sent':
    case 'found':
      return [
        `${st.s === 'found' ? 'Отклик найден на Профи.ру' : 'Отклик ушёл'}${st.t ? ` в ${st.t}` : ''}`,
        st.f ? `списано ${st.f}` : null,
      ]
        .filter(Boolean)
        .join(', ')
    case 'unsure':
      return 'Не знаю, ушёл ли отклик. Проверь заявку на Профи.ру, прежде чем откликаться вручную.'
    case 'closed':
      return 'Заявка закрыта на Профи.ру'
    case 'skipped':
      return 'Заявка пропущена'
    case 'stale':
      return 'Заявка устарела'
    case 'done':
      return 'Решено'
    default:
      return 'Карточка заявки'
  }
}

/** The text of the message the picture card is: Telegram HTML within one message. */
export function pictureText(c: LeadCard, st: CardState): string {
  const link = isTestOrder(c.orderId)
    ? '<i>Заявка понарошку, на Профи.ру её нет</i>'
    : `<a href="${orderUrl(c.orderId)}">Открыть на Профи.ру</a>`
  if (st.s !== 'new') {
    const note = st.n?.trim() ? esc(cut(st.n, 600)) : null
    return [`<b>${esc(stateText(st))}</b>`, note, link]
      .filter(Boolean)
      .join('\n')
      .replace(DASHES, '-')
  }
  const d = c.draft
  const name = firstName(c.clientInfo?.name?.trim() || c.clientName.trim() || '')
  const price = d?.priceRub
    ? (() => {
        const r = priceRange(d.priceRub, d.priceToRub)
        return ` · от ${formatRub(r.from)} до ${formatRub(r.to)}`
      })()
    : ''
  const series = (d?.followUps ?? []).map((t) => {
    const label = isCallOffer(t) ? 'Созвон' : isTelegramLine(t) ? 'Телеграм' : 'Вдогонку'
    return `<b>${label}:</b> ${esc(cut(t.split(SLOTS_MARK).join('три времени по рабочим часам'), 400))}`
  })
  const build = (wordsMax: number) =>
    [
      c.text.trim()
        ? `<b>Сообщение клиента${name ? ` · ${esc(name)}` : ''}</b>\n${quote(cut(c.text, wordsMax))}`
        : null,
      d
        ? `<b>Отклик</b>${price}\n${quote(cut(d.text, 1000))}`
        : esc('Черновика нет: нажми «Правка» и пришли текст отклика.'),
      series.length > 0 ? series.join('\n') : null,
      link,
    ]
      .filter((x): x is string => x !== null)
      .join('\n\n')
      .replace(DASHES, '-')
  // The client's words give way first, as little as it takes; everything else always fits.
  let wordsMax = 3000
  let html = build(wordsMax)
  while (telegramTextLength(html) > FIT && wordsMax > 200) {
    wordsMax = Math.max(200, wordsMax - (telegramTextLength(html) - FIT) - 20)
    html = build(wordsMax)
  }
  return html
}
