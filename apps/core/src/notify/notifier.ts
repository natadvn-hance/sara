import type { LeadCard } from './cards'

/**
 * Every message goes without sound at the quiet hours (FR-NOTIF-2); `loud` is for an urgent one, which keeps its
 * sound (a client's urgent word, FR-CONV-8).
 */
export type Notifier = {
  /** `silent` decides for this card; left out, the quiet hours do. */
  sendLeadCard(c: LeadCard, o?: { silent?: boolean }): Promise<{ messageId: number }>
  /**
   * The card of an order closed on Profi.ru, edited in place (the message `messageId`): the closed line is added and
   * the buttons go. It never throws: a message Telegram will not edit (deleted, already closed) is only logged.
   */
  closeLeadCard(messageId: number, c: LeadCard): Promise<void>
  /** `html`: the text is Telegram HTML (every value in it already escaped); the default is plain text. */
  sendText(text: string, o?: { html?: boolean; loud?: boolean }): Promise<{ messageId: number }>
  /** A message with inline buttons, row by row (the daily summary, rule proposals). */
  sendButtons(
    text: string,
    rows: { text: string; callbackData: string }[][],
    o?: { loud?: boolean },
  ): Promise<{ messageId: number }>
}
