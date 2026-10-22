import type { LeadCard } from './cards'

export type Notifier = {
  sendLeadCard(c: LeadCard): Promise<{ messageId: number }>
  sendText(text: string): Promise<void>
}
