import type { LeadCard } from './cards'

export type Notifier = {
  sendLeadCard(c: LeadCard): Promise<{ messageId: number }>
  sendText(text: string): Promise<{ messageId: number }>
  /** A message with inline buttons, row by row (the daily summary, rule proposals). */
  sendButtons(
    text: string,
    rows: { text: string; callbackData: string }[][],
  ): Promise<{ messageId: number }>
}
