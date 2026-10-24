import type { ConversationRow } from './types'

/**
 * Seconds the turn still waits for the client to finish (FR-CONV-7): the quiet after the last message the core heard
 * and after the last «печатает», never beyond the turn's longest wait. 0 means go now.
 */
export function quietLeftSeconds(
  c: Pick<ConversationRow, 'lastClientHeardAt' | 'typingAt'>,
  s: { quietAfterMessageS: number; quietAfterTypingS: number; maxWaitS: number },
  startedAt: Date,
  now: Date,
): number {
  const after = (iso: string | null, s: number) => (iso ? new Date(iso).getTime() + s * 1000 : 0)
  const until = Math.max(
    after(c.lastClientHeardAt, s.quietAfterMessageS),
    after(c.typingAt, s.quietAfterTypingS),
  )
  const cap = startedAt.getTime() + s.maxWaitS * 1000
  const left = Math.min(until, cap) - now.getTime()
  return left > 0 ? Math.ceil(left / 1000) : 0
}

/**
 * The human pause before a reply goes out (FR-CONV-8): a minute plus 0.3 seconds a letter plus up to 30 random
 * seconds, always between 1 and 4 minutes. `jitter` is a number from 0 to 1.
 */
export function humanPauseMs(textLength: number, jitter: number): number {
  const ms = 60_000 + textLength * 300 + Math.min(Math.max(jitter, 0), 1) * 30_000
  return Math.round(Math.min(Math.max(ms, 60_000), 240_000))
}
