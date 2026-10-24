import type { LeadCard } from './cards'

export type Notifier = {
  /** `silent`: delivered without sound, at quiet hours (FR-NOTIF-2). */
  sendLeadCard(c: LeadCard, o?: { silent?: boolean }): Promise<{ messageId: number }>
  sendText(text: string): Promise<{ messageId: number }>
  /** A message with inline buttons, row by row (the daily summary, rule proposals). */
  sendButtons(
    text: string,
    rows: { text: string; callbackData: string }[][],
  ): Promise<{ messageId: number }>
}
