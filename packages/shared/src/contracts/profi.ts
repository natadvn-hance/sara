import { z } from 'zod'

export const ProfiOrder = z.object({
  order_id: z.string().min(1),
  title: z.string(),
  category: z.string(),
  city: z.string(),
  text: z.string(),
  client_name: z.string(),
  budget_text: z.string().nullable(),
  bid_price_rub: z.number().int().nonnegative(),
  seen_at: z.iso.datetime(),
  /** When the site published the order; null or absent when not known (an older node, a page without it). */
  published_at: z.iso.datetime().nullable().optional(),
})
export type ProfiOrder = z.infer<typeof ProfiOrder>

export const SessionHealthInput = z.object({ account_id: z.string().min(1) })
export const SessionHealthOutput = z.object({
  alive: z.boolean(),
  balance_rub: z.number().int().nullable(),
  presence: z.boolean(),
  egress_ip: z.string().nullable(),
  /** Events waiting in the node's queue for the core (C8). */
  queued_events: z.number().int().nonnegative().optional(),
  /** Events the core refused as broken; they are never resent and need a look. */
  dead_events: z.number().int().nonnegative().optional(),
  /** False when nothing on the site was recognized for 10 minutes (layout changed). */
  eyes_seeing: z.boolean().optional(),
  /** False when the tab does not leave from the account's own IP; the account then stands (FR-ACC-1). */
  egress_ok: z.boolean().optional(),
})
export type SessionHealthInput = z.infer<typeof SessionHealthInput>
export type SessionHealthOutput = z.infer<typeof SessionHealthOutput>

export const SubmitBidInput = z.object({
  account_id: z.string().min(1),
  order_id: z.string().min(1),
  text: z.string().min(1),
  /** The «Стоимость услуги» field; null or absent leaves it empty (M2 design 4). */
  price_rub: z.number().int().positive().nullable().optional(),
  /** The «До» of the range; left out, the node puts half again over «от». */
  price_to_rub: z.number().int().positive().nullable().optional(),
  /** The most the bid may cost: the fee on the card Boris pressed. The node presses nothing when the site asks more. */
  max_fee_rub: z.number().int().nonnegative(),
  /** The node never presses after this moment: the core has stopped waiting for the answer by then. */
  not_after: z.iso.datetime(),
  idempotency_key: z.string().min(1),
  /** The core's signature over the key, the order, max_fee_rub and not_after. */
  permit: z.string().min(1),
})
export const SubmitBidOutput = z.object({
  found_on_page: z.boolean(),
  spent_rub: z.number().int().nonnegative(),
  balance_after_rub: z.number().int().nullable(),
  /** The page had this account's bid before this call pressed anything (Boris bid by hand): nothing was spent. */
  already_there: z.boolean().optional(),
})
export type SubmitBidInput = z.infer<typeof SubmitBidInput>
export type SubmitBidOutput = z.infer<typeof SubmitBidOutput>

export const PROFI_ERROR_CLASSES = [
  'SESSION_DEAD',
  'BANNED',
  'LAYOUT_CHANGED',
  'NOT_FOUND',
  'ORDER_CLOSED',
  'NO_MONEY',
  /** The site asks to pay some other way than the wallet: the node never confirms such a payment. */
  'UNSAFE_PAYMENT',
  /** The bid costs more than the core allowed (max_fee_rub): nothing was pressed. */
  'PRICE_CHANGED',
  'RATE_LIMITED',
  'UNCERTAIN',
  'INTERNAL',
  /** The chat got a message the core had not seen: nothing was typed, the turn plans again (FR-CONV-6). */
  'CHAT_CHANGED',
] as const
export type ProfiErrorClass = (typeof PROFI_ERROR_CLASSES)[number]

export const MessageAuthor = z.enum(['client', 'specialist', 'system', 'unknown'])
export type MessageAuthor = z.infer<typeof MessageAuthor>

const since = z.iso.datetime().optional()

export const FeedOrder = z.object({
  order_id: z.string().min(1),
  title: z.string(),
  city: z.string(),
  budget_text: z.string().nullable(),
  bid_price_rub: z.number().int().nonnegative().nullable(),
  published_at: z.iso.datetime().nullable(),
})
export type FeedOrder = z.infer<typeof FeedOrder>
export const ListFeedInput = z.object({ account_id: z.string().min(1), since })
export const ListFeedOutput = z.object({ orders: z.array(FeedOrder) })

export const GetOrderInput = z.object({
  account_id: z.string().min(1),
  order_id: z.string().min(1),
})
/**
 * What the order page says about the client (the backoffice answer getKlientInfo): shown on the card and read by
 * the Scorer for the client's quality. Every part may be missing on a page that does not show it.
 */
export const ClientInfo = z.object({
  name: z.string().nullable(),
  /** As the site writes it, e.g. «На Профи.ру с 7 сентября 2020». */
  on_profi_since: z.string().nullable(),
  phone_verified: z.boolean().nullable(),
  /** Other specialists' reviews of this client. */
  reviews: z
    .object({ positive: z.number().int().nonnegative(), negative: z.number().int().nonnegative() })
    .nullable(),
  /** Short tags of those reviews, newest first («Перестала отвечать»). */
  review_tags: z.array(z.string()).max(10),
})
export type ClientInfo = z.infer<typeof ClientInfo>

/**
 * A file the client attached to the order (the order page's documents and gallery, Boris 30.10.2026 evening: «файлы …
 * эту информацию нужно будет изучать перед откликом»): the technical task as a PDF, DOCX or XLSX, pictures, a brief.
 */
export const OrderAttachment = z.object({
  kind: z.enum(['document', 'image']),
  url: z.string().min(1),
  name: z.string(),
})
export type OrderAttachment = z.infer<typeof OrderAttachment>

export const GetOrderOutput = ProfiOrder.extend({
  open: z.boolean(),
  published_at: z.iso.datetime().nullable(),
  /** This account already bid on the order (from the order page answer); null when not known. */
  has_bid: z.boolean().nullable(),
  /** The client as the order page shows them; absent from a node that does not read it yet. */
  client_info: ClientInfo.nullable().optional(),
  /**
   * True when open, has_bid and the fee come from the order page read now. False: the node could not read the page
   * (the tab may not move, the page gave no order answer) and answers from what it stored; absent: an older node.
   */
  from_page: z.boolean().optional(),
  /** The files attached to the order; absent from a node that does not read them yet, empty when there are none. */
  attachments: z.array(OrderAttachment).optional(),
})
export type GetOrderOutput = z.infer<typeof GetOrderOutput>

export const ChatSummary = z.object({
  chat_id: z.string().min(1),
  order_id: z.string().nullable(),
  last_message_at: z.iso.datetime().nullable(),
  unread: z.number().int().nonnegative(),
})
export type ChatSummary = z.infer<typeof ChatSummary>
export const ListChatsInput = z.object({ account_id: z.string().min(1), since })
export const ListChatsOutput = z.object({ chats: z.array(ChatSummary) })

export const ChatMessage = z.object({
  platform_message_id: z.string().min(1),
  chat_id: z.string().min(1),
  author: MessageAuthor,
  sent_at: z.iso.datetime(),
  text: z.string(),
  read: z.boolean(),
})
export type ChatMessage = z.infer<typeof ChatMessage>
export const ReadChatInput = z.object({ account_id: z.string().min(1), chat_id: z.string().min(1) })
export const ReadChatOutput = z.object({ messages: z.array(ChatMessage) })

/**
 * A message to a client through the chat page (FR-CONV-9). The node reads the live page right before typing and
 * refuses with CHAT_CHANGED when its last message is not `expect_last_message_id` (null: the chat had none).
 */
export const SendMessageInput = z.object({
  account_id: z.string().min(1),
  chat_id: z.string().min(1),
  text: z.string().min(1).max(4000),
  expect_last_message_id: z.string().min(1).nullable(),
  idempotency_key: z.string().min(1),
  permit: z.string().min(1),
})
export const SendMessageOutput = z.object({
  found_on_page: z.boolean(),
  platform_message_id: z.string().min(1).nullable(),
})
export type SendMessageInput = z.infer<typeof SendMessageInput>
export type SendMessageOutput = z.infer<typeof SendMessageOutput>

export type ListFeedInput = z.infer<typeof ListFeedInput>
export type ListFeedOutput = z.infer<typeof ListFeedOutput>
export type GetOrderInput = z.infer<typeof GetOrderInput>
export type ListChatsInput = z.infer<typeof ListChatsInput>
export type ListChatsOutput = z.infer<typeof ListChatsOutput>
export type ReadChatInput = z.infer<typeof ReadChatInput>
export type ReadChatOutput = z.infer<typeof ReadChatOutput>

/** C2: tools of Profi-MCP. Mutating tools take an idempotency key and the core's permit. */
export const PROFI_TOOLS = {
  'profi.session_health': { input: SessionHealthInput, output: SessionHealthOutput },
  'profi.list_feed': { input: ListFeedInput, output: ListFeedOutput },
  'profi.get_order': { input: GetOrderInput, output: GetOrderOutput },
  'profi.list_chats': { input: ListChatsInput, output: ListChatsOutput },
  'profi.read_chat': { input: ReadChatInput, output: ReadChatOutput },
  'profi.submit_bid': { input: SubmitBidInput, output: SubmitBidOutput },
  'profi.send_message': { input: SendMessageInput, output: SendMessageOutput },
} as const

const MessageRef = z
  .object({
    chat_id: z.string().min(1),
    order_id: z.string().nullable(),
    platform_message_id: z.string().min(1),
    sent_at: z.iso.datetime(),
    author: MessageAuthor,
    /**
     * How the node noticed the message: the event stream named its chat («stream», sent_at is the moment of that
     * notice), or only a chat sweep found it («sweep», sent_at is the moment it was read: how late it is, is not
     * known). Absent: an older node.
     */
    seen_via: z.enum(['stream', 'sweep']).optional(),
  })
  .strict()

/** C2 notifications, Profi-MCP → core over C8. Payloads never carry a client's text (ADR-022). */
export const PROFI_EVENT_PAYLOADS = {
  'profi.order_seen': ProfiOrder,
  /** `page`: the page of the board (from 0) where the last pass saw the order. */
  'profi.order_gone': z.object({ page: z.number().int().nonnegative() }).strict(),
  'profi.client_message': MessageRef,
  'profi.author_unclear': MessageRef,
  /** A new message from our side of the chat: Boris's, old Sara's or new Sara's (ADR-024). */
  'profi.specialist_message': MessageRef.extend({ author: z.literal('specialist') }).strict(),
  'profi.client_typing': z.object({ chat_id: z.string().min(1), at: z.iso.datetime() }).strict(),
  'profi.client_read': z
    .object({
      chat_id: z.string().min(1),
      platform_message_id: z.string().min(1).nullable(),
      at: z.iso.datetime(),
    })
    .strict(),
  'profi.session_dead': z.object({}).strict(),
  'profi.session_alive': z.object({ dead_since: z.iso.datetime().nullable() }).strict(),
  'profi.profile_banned': z.object({}).strict(),
  'profi.layout_changed': z.object({ what: z.enum(['rtp', 'response', 'dom']) }).strict(),
  'profi.balance_changed': z.object({ balance_rub: z.number().int() }).strict(),
  'profi.connection_lost': z.object({ since: z.iso.datetime() }).strict(),
  'profi.connection_back': z.object({ since: z.iso.datetime() }).strict(),
} as const
export type ProfiEventType = keyof typeof PROFI_EVENT_PAYLOADS
export type ProfiToolName = keyof typeof PROFI_TOOLS
