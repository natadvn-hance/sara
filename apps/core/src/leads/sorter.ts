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
