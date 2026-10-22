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
})
export type SessionHealthInput = z.infer<typeof SessionHealthInput>
export type SessionHealthOutput = z.infer<typeof SessionHealthOutput>

export const SubmitBidInput = z.object({
  account_id: z.string().min(1),
  order_id: z.string().min(1),
  text: z.string().min(1),
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
  'RATE_LIMITED',
  'UNCERTAIN',
  'INTERNAL',
] as const
export type ProfiErrorClass = (typeof PROFI_ERROR_CLASSES)[number]

/** C2: tools of Profi-MCP available in M0. */
export const PROFI_TOOLS = {
  'profi.session_health': { input: SessionHealthInput, output: SessionHealthOutput },
  'profi.submit_bid': { input: SubmitBidInput, output: SubmitBidOutput },
} as const
export type ProfiToolName = keyof typeof PROFI_TOOLS
