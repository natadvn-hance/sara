const DEFAULT_ROOT = 'https://api.telegram.org'

/** Checks a bot token with Telegram's getMe. */
export async function getMe(
  token: string,
  apiRoot: string = DEFAULT_ROOT,
): Promise<{ ok: true; username: string } | { ok: false; reason: 'unauthorized' | 'network' }> {
  let res: Response
  try {
    res = await fetch(`${apiRoot}/bot${token}/getMe`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (res.status === 401 || res.status === 404) return { ok: false, reason: 'unauthorized' }
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean
    result?: { username?: string }
  } | null
  if (!body?.ok || !body.result?.username) return { ok: false, reason: 'network' }
  return { ok: true, username: body.result.username }
}
