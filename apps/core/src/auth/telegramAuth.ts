import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The Mini App's entry (M7 design 7, pult v2 design 7): Telegram signs the `initData` it hands the app with the
 * bot's token. The pult sends it as `Authorization: tma <initData>`; the core lets the request in when the
 * signature is the working bot's, the data is not older than a day, and the user is Boris (bound by /start).
 */

/** How long a signed `initData` is good for: Telegram hands a fresh one at every opening. */
export const INIT_DATA_MAX_AGE_S = 24 * 3600

export type InitDataCheck =
  | { ok: true; userId: number; authDate: number }
  | { ok: false; why: 'malformed' | 'signature' | 'expired' | 'no_user' }

/** The hash Telegram puts into `initData`, from every other field sorted by name. */
export function initDataHash(fields: [string, string][], botToken: string): string {
  const check = fields
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  return createHmac('sha256', secret).update(check).digest('hex')
}

export function checkInitData(raw: string, botToken: string, now = Date.now()): InitDataCheck {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(raw)
  } catch {
    return { ok: false, why: 'malformed' }
  }
  const hash = params.get('hash')
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, why: 'malformed' }
  const expected = initDataHash([...params.entries()], botToken)
  const a = Buffer.from(hash.toLowerCase(), 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, why: 'signature' }
  const authDate = Number(params.get('auth_date'))
  if (!Number.isFinite(authDate) || now / 1000 - authDate > INIT_DATA_MAX_AGE_S)
    return { ok: false, why: 'expired' }
  try {
    const user = JSON.parse(params.get('user') ?? 'null') as { id?: unknown } | null
    if (typeof user?.id !== 'number') return { ok: false, why: 'no_user' }
    return { ok: true, userId: user.id, authDate }
  } catch {
    return { ok: false, why: 'no_user' }
  }
}

/** Failed signatures per address in the last minute, counted apart from passwords (only failures count). */
const failures = new Map<string, number[]>()
export function tooManyBadSignatures(ip: string, fail: boolean, now = Date.now()): boolean {
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (fail) recent.push(now)
  failures.set(ip, recent)
  return recent.length > 5
}
