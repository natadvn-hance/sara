import { createHmac, timingSafeEqual } from 'node:crypto'

export function signPermit(secret: string, idempotencyKey: string): string {
  return createHmac('sha256', secret).update(idempotencyKey).digest('hex')
}

export function verifyPermit(secret: string, idempotencyKey: string, permit: string): boolean {
  const expected = Buffer.from(signPermit(secret, idempotencyKey), 'hex')
  const given = Buffer.from(permit, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
