import type { LeadCard } from './cards'
import type { NoticeHint } from './center'

/**
 * Where a message belongs once Boris has a forum (docs/product/telegram-forum.md): the topic of one client's order
 * (by the conversation, or by the order before a conversation exists), the topic of new orders, or the general one
 * (left out). Without a forum every place is his one chat.
 */
export type Place = { conversation: string } | { order: string } | 'leads' | 'general'

/**
 * Every message goes without sound at the quiet hours (FR-NOTIF-2); `loud` is for an urgent one, which keeps its
 * sound (a client's urgent word, FR-CONV-8).
 */
export type Notifier = {
  /** `silent` decides for this card; left out, the quiet hours do. A card goes to the topic of new orders. */
  sendLeadCard(c: LeadCard, o?: { silent?: boolean }): Promise<{ messageId: number }>
  /**
   * The card of an order closed on Profi.ru, edited in place (the message `messageId`): the closed line is added and
   * the buttons go. It never throws: a message Telegram will not edit (deleted, already closed) is only logged.
   */
  closeLeadCard(messageId: number, c: LeadCard): Promise<void>
  /** `html`: the text is Telegram HTML (every value in it already escaped); the default is plain text. */
  sendText(
    text: string,
    o?: { html?: boolean; loud?: boolean; place?: Place; notice?: NoticeHint },
  ): Promise<{ messageId: number }>
  /** A message with inline buttons, row by row (the daily summary, rule proposals). */
  sendButtons(
    text: string,
    rows: { text: string; callbackData: string }[][],
    o?: { html?: boolean; loud?: boolean; place?: Place; notice?: NoticeHint },
  ): Promise<{ messageId: number }>
  /** «печатает…» in the chat for a few seconds: Sara is busy with Boris's words (ADR-027). */
  typing?(): Promise<void>
  /**
   * A card decided in the pult (M7 design 2): its buttons give way to one line saying so, so no live button is left
   * on a decided task. It never throws: a message Telegram will not edit is only logged.
   */
  markDone?(messageId: number, note: string): Promise<void>
  /** Changes a sent message without a sound (M4: the shadow card gets the real reply); rows keep its buttons. */
  editText?(
    messageId: number,
    text: string,
    rows?: { text: string; callbackData: string }[][],
    o?: { html?: boolean },
  ): Promise<void>
  /** The link to the client's topic in the forum; null without a forum or before the topic exists. It never throws. */
  topicLink?(place: { conversation: string }): Promise<string | null>
  /**
   * The client's topic ends (the conversation closed): `outcome` is its last line, the name says so and the topic
   * closes. The next message to it opens it again. Nothing without a forum or a topic; it never throws.
   */
  closeTopic?(place: { conversation: string }, outcome: string): Promise<void>
}
