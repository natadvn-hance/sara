/** FR-LEAD-10: an order older than this is not offered. */
const STALE_AFTER_MS = 24 * 3600_000

/** Published over 24 hours ago; an order without a publication time is never stale. */
export function isStale(publishedAt: string | null | undefined, now: Date): boolean {
  if (!publishedAt) return false
  return now.getTime() - new Date(publishedAt).getTime() > STALE_AFTER_MS
}
