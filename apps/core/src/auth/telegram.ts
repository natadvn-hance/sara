import { createHmac, timingSafeEqual } from 'node:crypto'

const DAY_S = 24 * 3600

export type InitDataCheck =
  | { ok: true; userId: number }
  | { ok: false; reason: 'format' | 'signature' | 'expired' | 'user' | 'no_owner' }

/**
 * The Mini App's launch data, checked the way Telegram documents it and old Sara did since 20.10 (M7 design,
 * section 7): the secret is HMAC-SHA256 of the bot token keyed by "WebAppData"; the hash is HMAC-SHA256 of every
 * other field, sorted by name, `key=value` joined by new lines. Only Boris (the user bound by /start) gets in, and
 * a signature older than a day does not: Telegram signs anew each time the app is opened.
 */
export function verifyInitData(
  initData: string,
  o: { botToken: string; ownerUserId: number | null; nowMs: number; maxAgeS?: number },
): InitDataCheck {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'format' }
  params.delete('hash')
  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(o.botToken).digest()
  const expected = createHmac('sha256', secret).update(check).digest()
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return { ok: false, reason: 'signature' }
  if (o.ownerUserId === null) return { ok: false, reason: 'no_owner' }
  const signedAt = Number(params.get('auth_date'))
  if (!Number.isFinite(signedAt) || signedAt * 1000 < o.nowMs - (o.maxAgeS ?? DAY_S) * 1000)
    return { ok: false, reason: 'expired' }
  let userId: unknown = null
  try {
    userId = (JSON.parse(params.get('user') ?? 'null') as { id?: unknown } | null)?.id ?? null
  } catch {
    return { ok: false, reason: 'user' }
  }
  if (userId !== o.ownerUserId) return { ok: false, reason: 'user' }
  return { ok: true, userId }
}

/** The launch data a request carries as `Authorization: tma <initData>`, or null. */
export function tmaFrom(header: string | undefined): string | null {
  const m = /^tma (.+)$/.exec(header ?? '')
  return m?.[1] ?? null
}
