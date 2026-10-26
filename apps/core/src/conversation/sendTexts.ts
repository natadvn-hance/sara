/** What Boris is told about a text that went (or did not) to a client, and the shape of one send (FR-CONV-9). */

export const SEND_TEXTS = {
  sent: 'Отправила клиенту.',
  changed: 'Клиент успел дописать: текст не ушёл. Посмотри новые сообщения и пришли текст ещё раз.',
  notNow: 'Сейчас не отправляю: включён режим тени или пауза «Пишет клиентам».',
  failed: 'Не смогла отправить: проверь вход в Профи.ру. Текст сохранила.',
  uncertain: 'Не уверена, что сообщение дошло. Проверь чат в Профи.ру, повторно не отправляю.',
  /** The answer to a press while the send runs in its own process; the result comes as a new message. */
  sending: 'Отправляю…',
}

/** The draft behind a card is out of date: the client wrote while Boris was deciding. */
export const STALE_DRAFT =
  'Черновик устарел: клиент успел дописать. Текст не ушёл, посмотри новые сообщения.'

/** What a send does with the card and the trace row it came from once it is over. */
export type SendAfter =
  | { kind: 'draft'; taskId: string }
  | { kind: 'reminder'; rowId: string; taskId: string; how: 'send' | 'edit' }

/**
 * What a text sent now may be told: the last message of the chat it was written for (the service refuses a chat that
 * moved on), and the key that makes a repeat of the same request (a Telegram update delivered twice, a retried API
 * call) one message; left out, every call is a new message. `after` says which card and row the send settles,
 * `ground` that the chat of a reminder is read again first, `notBefore` that it waits for a time.
 */
export type SendOptions = {
  expectLast?: string | null
  key?: string
  after?: SendAfter
  ground?: { anchor: string }
  notBefore?: string
}

/** One text to one client, everything it needs to be sent, kept and told about (it is the input of the send process). */
export type SendJob = {
  conversationId: string
  text: string
  author: 'sara' | 'boris'
  key: string
  expectLast: string | null
  after?: SendAfter
  ground?: { anchor: string }
  notBefore?: string
}

/** How a send ended: the delivery's answer, or a reread that says wait («not_now») or that it is no longer wanted. */
export type SendOutcome =
  | { kind: 'answer'; answer: string }
  | { kind: 'not_now'; why: string }
  | { kind: 'gone'; why: string }
