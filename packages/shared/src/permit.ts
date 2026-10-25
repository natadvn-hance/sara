import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** What the core's permit for a bid covers: the key, the order, the most it may cost and the last moment to press. */
export type PermitFields = {
  idempotency_key: string
  order_id: string
  max_fee_rub: number
  not_after: string
}

// The tool's name first: a permit for one tool is never good for another.
const signed = (f: PermitFields) =>
  ['submit_bid', f.idempotency_key, f.order_id, String(f.max_fee_rub), f.not_after].join('\n')

export function signPermit(secret: string, f: PermitFields): string {
  return createHmac('sha256', secret).update(signed(f)).digest('hex')
}

export function verifyPermit(secret: string, f: PermitFields & { permit: string }): boolean {
  const expected = Buffer.from(signPermit(secret, f), 'hex')
  const given = Buffer.from(f.permit, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export type MessagePermit = { accountId: string; chatId: string; text: string; key: string }

/** A permit for one message (FR-CONV-9): good only for this account, chat, text and key, never as a bid permit. */
export function signMessagePermit(secret: string, m: MessagePermit): string {
  const text = createHash('sha256').update(m.text).digest('hex')
  return createHmac('sha256', secret)
    .update(`send_message|${m.accountId}|${m.chatId}|${text}|${m.key}`)
    .digest('hex')
}

export function verifyMessagePermit(secret: string, m: MessagePermit, permit: string): boolean {
  const expected = Buffer.from(signMessagePermit(secret, m), 'hex')
  const given = Buffer.from(permit, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
