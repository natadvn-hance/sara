import { formatRub, isTestOrder, plural, priceRange } from '@sara/shared'
import { isCallOffer } from '../leads/callSlots'
import { isTelegramLine } from '../leads/telegramLine'
import type { CardState } from './cardState'
import { esc, type LeadCard, MESSAGE_LIMIT, orderUrl, plusMinus, telegramTextLength } from './cards'
import { thought, whoLine } from './picture'

/**
 * The lead card as one wide text message (FR-NOTIF-6, setting `cards.picture`). Boris saw the picture cards of 12.11
 * shrunk in the chat («Ну это полный кошмар… большая, на весь экран, растягивалась до часов») and chose «Текстом на
 * всю ширину»: no picture and no link preview. A new card: the title in bold, where and who, the figures in one line,
 * the plus, the minus and the risk, then the client's words folded, «Отклик · от … до …» with the bid folded and the
 * series in one line; a later state: the title and what happened.
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

/** Where and who: «дистанционно · Москва · Артём, на Профи с 2023». */
function metaText(c: LeadCard): string {
  const place = c.city
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^Дистанционно/u, 'дистанционно')
  return [place, whoLine(c)].filter(Boolean).join(' · ')
}

/** The figures in one line, their values in bold: the score, the client's budget, the fee for the bid. */
function figuresText(c: LeadCard, st: CardState): string {
  const score = c.score?.value ?? null
  const fee = st.f ?? (c.bidPriceRub > 0 ? formatRub(c.bidPriceRub) : null)
  return [
    score === null ? 'Без оценки' : `Балл <b>${score}/100</b>`,
    `Бюджет <b>${esc(c.budgetText?.trim() || 'не указан')}</b>`,
    fee ? `Отклик <b>${esc(fee)}</b>` : null,
    c.autobid ? '<i>сама бы откликнулась</i>' : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The plus, the minus and the risk, a line each, as the text card marks them. */
function reasonsText(c: LeadCard): string | null {
  const pm = plusMinus(c.score?.reason ?? c.reason ?? '')
  const risk = c.analysis?.risk?.trim()
  // Each a sentence of its own: «Подходит: стратегия…» gives «Стратегия…».
  const line = (t: string) => {
    const s = thought(t, 120)
    return esc(`${s.charAt(0).toUpperCase()}${s.slice(1)}`)
  }
  const rows = [
    pm.plus.trim() ? `➕ ${line(pm.plus)}` : null,
    pm.minus?.trim() ? `➖ ${line(pm.minus)}` : null,
    risk ? `⚠️ ${line(risk)}` : null,
  ].filter((r): r is string => r !== null)
  return rows.length > 0 ? rows.join('\n') : null
}

/** The state of a short card in one sentence; none for a note, which says it all. */
function stateText(st: CardState): string | null {
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
      return null
  }
}

/** The text of the wide card: Telegram HTML within one message. */
export function pictureText(c: LeadCard, st: CardState): string {
  const link = isTestOrder(c.orderId)
    ? '<i>Заявка понарошку, на Профи.ру её нет</i>'
    : `<a href="${orderUrl(c.orderId)}">Открыть на Профи.ру</a>`
  const title = `<b>${esc(cut(c.title, 200).replace(/\s+/g, ' '))}</b>`
  if (st.s !== 'new') {
    const said = stateText(st)
    const note = st.n?.trim() ? esc(cut(st.n, 600)) : null
    return [title, said ? esc(said) : null, note, link]
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
  const head = [`${title}\n${esc(metaText(c))}`, figuresText(c, st), reasonsText(c)]
  const build = (wordsMax: number) =>
    [
      ...head,
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
