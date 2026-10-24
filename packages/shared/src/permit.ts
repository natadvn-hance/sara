import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export function signPermit(secret: string, idempotencyKey: string): string {
  return createHmac('sha256', secret).update(idempotencyKey).digest('hex')
}

export function verifyPermit(secret: string, idempotencyKey: string, permit: string): boolean {
  const expected = Buffer.from(signPermit(secret, idempotencyKey), 'hex')
  const given = Buffer.from(permit, 'hex')
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
