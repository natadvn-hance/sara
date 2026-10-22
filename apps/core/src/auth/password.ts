import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, n: number) => Promise<Buffer>

export async function hashPassword(p: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(p, salt, 64)
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`
}

export async function verifyPassword(p: string, stored: string): Promise<boolean> {
  const [kind, saltHex, keyHex] = stored.split(':')
  if (kind !== 'scrypt' || !saltHex || !keyHex) return false
  const expected = Buffer.from(keyHex, 'hex')
  const key = await scrypt(p, Buffer.from(saltHex, 'hex'), expected.length)
  return timingSafeEqual(key, expected)
}
