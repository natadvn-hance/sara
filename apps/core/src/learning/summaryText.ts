import { formatRub, plural } from '@sara/shared'
import { esc } from '../notify/cards'

/** The day's numbers of the evening report, 19:00 to 19:00. */
export type DayCounts = {
  /** Orders Sara saw on the board. */
  seen: number
  /** The Sorter said it is not ours. */
  sorted: number
  /** The score or a stop factor dropped it. */
  scored: number
  /** Cards Boris got, by kind. */
  marketing: number
  sites: number
  other: number
  bids: number
  spentRub: number
}

export type ScreenLine = { stopped: number; stoppedBy: string; marked: number; markedBy: string }
export type NearOrder = {
  orderId: string
  title: string
  score: number
  threshold: number
  reason: string
}
export type HeldOrder = { orderId: string; title: string; score: number | null }

const MAX_REASON = 140
const orderUrl = (id: string) => `https://profi.ru/backoffice/n.php?o=${encodeURIComponent(id)}`
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const link = (id: string, title: string) => `<a href="${orderUrl(id)}">${esc(oneLine(title))}</a>`

/** Why it fell short, in one line: the Scorer ends its reason with that; the screen's minus has its own place. */
export function shortReason(reason: string): string {
  const clean = oneLine(reason.replace(/\(минус[^)]*\)/giu, ''))
  const last =
    clean
      .split(/(?<=[.!?])\s+/u)
      .filter(Boolean)
      .at(-1) ?? clean
  const text = last.replace(/[.\s]+$/u, '')
  if (text.length <= MAX_REASON) return text
  const cut = text.slice(0, MAX_REASON)
  return `${cut.slice(0, cut.lastIndexOf(' ')).trimEnd()}…`
}

const dayName = (now: Date) =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: 'numeric',
    month: 'long',
  }).format(now)

/**
 * The evening report (Boris, 04.11.2026: «сделай этот ежедневный отчет в более понятном виде»): the day's way from
 * the board to the bids in short lines, then the orders that nearly passed, numbered as the buttons under it.
 */
export function summaryText(o: {
  now: Date
  counts: DayCounts
  screen: ScreenLine
  near: NearOrder[]
  held: HeldOrder[]
  heldMore: number
}): string {
  const c = o.counts
  const cards = c.marketing + c.sites + c.other
  const lines = [
    `📊 <b>Итоги дня</b> · ${dayName(o.now)}`,
    '',
    `Заявок на доске: ${c.seen}`,
    `Не наш профиль: ${c.sorted}`,
    `Балл или стоп-фактор: ${c.scored}`,
    ...(o.screen.stopped > 0 ? [`Отсеяно сразу: ${o.screen.stoppedBy}`] : []),
    `<b>Карточек вам: ${cards}</b>${cards > 0 ? ` (маркетинг ${c.marketing}, сайты ${c.sites}, остальное ${c.other})` : ''}`,
    `Откликов: ${c.bids}${c.spentRub > 0 ? `, потрачено ${formatRub(c.spentRub)}` : ''}`,
  ]
  if (o.near.length > 0) {
    lines.push('', '<b>Почти прошли, посмотрите:</b>')
    o.near.forEach((n, i) => {
      lines.push(
        `${i + 1}. ${link(n.orderId, n.title)}, балл ${n.score} при пороге ${n.threshold}`,
        esc(shortReason(n.reason)),
      )
    })
  }
  if (o.held.length > 0) {
    lines.push('', '<b>Ещё показала бы, карточек за день было больше лимита:</b>')
    o.held.forEach((h, i) => {
      const score = h.score === null ? 'без оценки' : `балл ${h.score}`
      lines.push(`${o.near.length + i + 1}. ${link(h.orderId, h.title)}, ${score}`)
    })
    if (o.heldMore > 0)
      lines.push(`И ещё ${o.heldMore} ${plural(o.heldMore, ['заявка', 'заявки', 'заявок'])}`)
  }
  if (o.screen.marked > 0)
    lines.push(
      '',
      `<blockquote expandable>Отсев отметил ещё ${o.screen.marked} и пропустил дальше: ${esc(o.screen.markedBy)}</blockquote>`,
    )
  return lines.join('\n')
}
