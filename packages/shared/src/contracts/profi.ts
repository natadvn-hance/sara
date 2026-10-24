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
  idempotency_key: z.string().min(1),
  permit: z.string().min(1),
})
export const SubmitBidOutput = z.object({
  found_on_page: z.boolean(),
  spent_rub: z.number().int().nonnegative(),
  balance_after_rub: z.number().int().nullable(),
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
  'RATE_LIMITED',
  'UNCERTAIN',
  'INTERNAL',
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
export const GetOrderOutput = ProfiOrder.extend({
  open: z.boolean(),
  published_at: z.iso.datetime().nullable(),
  /** This account already bid on the order (from the order page answer); null when not known. */
  has_bid: z.boolean().nullable(),
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
} as const

const MessageRef = z
  .object({
    chat_id: z.string().min(1),
    order_id: z.string().nullable(),
    platform_message_id: z.string().min(1),
    sent_at: z.iso.datetime(),
    author: MessageAuthor,
  })
  .strict()

/** C2 notifications, Profi-MCP → core over C8. Payloads never carry a client's text (ADR-022). */
export const PROFI_EVENT_PAYLOADS = {
  'profi.order_seen': ProfiOrder,
  'profi.client_message': MessageRef,
  'profi.author_unclear': MessageRef,
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
