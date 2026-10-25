import { type ProfiOrder, SorterOutput } from '@sara/shared'
import type { Gateway, RoleCallResult } from '../gateway/gateway'
import { namesToHide } from './clientName'

/** Text the Sorter sees. The client's name is never put in it, and one inside the text is hidden by the gateway (ADR-016). */
export function sorterInput(
  o: Pick<ProfiOrder, 'title' | 'category' | 'city' | 'budget_text' | 'text'>,
): string {
  return [
    `Тема: ${o.title}`,
    `Категория: ${o.category}`,
    `Город: ${o.city}`,
    `Бюджет: ${o.budget_text ?? 'не указан'}`,
    `Описание: ${o.text}`,
  ].join('\n')
}

/**
 * The Scorer and the Analyst are told as a fact that the client raised an old order again: it is no fresh order, the
 * client has not found anyone yet, and the site may say when they asked again. The Sorter reads the board as it is.
 */
export function repostedLine(o: Pick<ProfiOrder, 'reposted' | 'repost_notice'>): string | null {
  if (!o.reposted) return null
  const base = 'Заказ поднят повторно: старый заказ, клиент ещё не нашёл исполнителя.'
  const notice = o.repost_notice?.replace(/\s+/g, ' ').trim().slice(0, 200)
  return notice ? `${base} Сайт пишет: ${notice}` : base
}

export function sortOrder(
  gw: Gateway,
  o: ProfiOrder,
  opts?: { correlationId?: string; causationId?: string },
): Promise<RoleCallResult<SorterOutput>> {
  return gw.call('sorter', sorterInput(o), SorterOutput, {
    ...opts,
    redact: { names: namesToHide(o.client_name) },
  })
}
