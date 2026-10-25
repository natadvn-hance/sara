import { createHmac } from 'node:crypto'

export const TEST_BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop'
export const OWNER_TG_ID = 777

/** A Mini App launch string signed the way Telegram signs it (values decoded, sorted, joined by new lines). */
export function signInitData(
  fields: Record<string, string>,
  botToken: string = TEST_BOT_TOKEN,
): string {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const hash = createHmac('sha256', secret).update(check).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}

/** Boris's launch data, signed now (or `ageS` seconds ago). */
export function ownerInitData(
  o: { userId?: number; ageS?: number; botToken?: string; nowMs?: number } = {},
): string {
  const now = Math.floor((o.nowMs ?? Date.now()) / 1000) - (o.ageS ?? 0)
  return signInitData(
    {
      query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
      user: JSON.stringify({ id: o.userId ?? OWNER_TG_ID, first_name: 'Борис' }),
      auth_date: String(now),
    },
    o.botToken,
  )
}
