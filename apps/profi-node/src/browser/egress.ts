import type { Page } from 'playwright'

/** Which IP the site sees from this tab; it must be the account's own (FR-ACC-1). */
export async function checkEgress(
  page: Page,
  echoUrl: string,
  expectedIp: string,
): Promise<{ ok: boolean; seen: string | null }> {
  // A separate short-lived tab of the same context: same proxy, the live tab is not disturbed.
  const probe = await page.context().newPage()
  try {
    const res = await probe.goto(echoUrl, { timeout: 15000 })
    const seen = ((await res?.text()) ?? '').trim().replace(/^::ffff:/, '') || null
    return { ok: seen === expectedIp, seen }
  } catch {
    return { ok: false, seen: null }
  } finally {
    await probe.close().catch(() => {})
  }
}
