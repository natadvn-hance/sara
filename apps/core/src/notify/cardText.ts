import { formatRub, isTestOrder, plural, priceRange } from '@sara/shared'
import { isCallOffer } from '../leads/callSlots'
import { isTelegramLine } from '../leads/telegramLine'
import type { CardState } from './cardState'
import { esc, type LeadCard, MESSAGE_LIMIT, orderUrl, telegramTextLength } from './cards'

/**
 * The text under a picture card (FR-NOTIF-6, 12.11.2026): what is long and may be copied goes as Telegram text, the
 * picture above it keeps only the main. A new card, by the mock Boris approved: the client's words folded, «Отклик · от
 * … до …» with the bid folded, then the series in one line; a later state: one sentence of what happened.
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

/**
 * The series under the bid in one line (the mock of 12.11.2026): «Вдогонку: созвон на 30 минут, телеграм». The call
 * offer and the Telegram line are known templates; any other message follows folded, so Boris reads what goes.
 */
function seriesText(followUps: string[]): string | null {
  if (followUps.length === 0) return null
  const own = followUps.filter((t) => !isCallOffer(t) && !isTelegramLine(t))
  const call = followUps.find(isCallOffer)
  const minutes = call
    ? /полчаса/iu.test(call)
      ? '30'
      : (call.match(/(\d+)\s*минут/u)?.[1] ?? call.match(/минут\S*\s+на\s+(\d+)/u)?.[1])
    : undefined
  const n = own.length
  const kinds = [
    n > 0 ? `${n > 1 ? `${n} ` : ''}${plural(n, ['сообщение', 'сообщения', 'сообщений'])}` : null,
    call ? `созвон${minutes ? ` на ${minutes} минут` : ''}` : null,
    followUps.some(isTelegramLine) ? 'телеграм' : null,
  ].filter((k): k is string => k !== null)
  const line = `<b>Вдогонку:</b> ${kinds.join(', ')}`
  return n > 0 ? `${line}\n${quote(own.map((t) => cut(t, 400)).join('\n\n'))}` : line
}

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
  // «от 7 000 до 10 000 ₽», one sign at the end (the mock of 12.11.2026).
  const price = d?.priceRub
    ? (() => {
        const r = priceRange(d.priceRub, d.priceToRub)
        return ` · от ${formatRub(r.from).replace(/\s*₽$/u, '')} до ${formatRub(r.to)}`
      })()
    : ''
  const series = seriesText(d?.followUps ?? [])
  const build = (wordsMax: number) =>
    [
      c.text.trim() ? quote(cut(c.text, wordsMax)) : null,
      d
        ? `<b>Отклик</b>${price}\n${quote(cut(d.text, 1000))}`
        : esc('Черновика нет: нажми «Правка» и пришли текст отклика.'),
      series,
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
