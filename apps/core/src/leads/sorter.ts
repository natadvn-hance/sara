import { type ProfiOrder, SorterOutput } from '@sara/shared'
import type { Gateway, RoleCallResult } from '../gateway/gateway'

/** Text the Sorter sees. The client's name is never sent to the model (ADR-016). */
export function sorterInput(o: ProfiOrder): string {
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
  return gw.call('sorter', sorterInput(o), SorterOutput, opts)
}
