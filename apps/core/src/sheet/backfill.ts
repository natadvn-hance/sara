import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { sheetSync } from '../db/schema'
import type { Notifier } from '../notify/notifier'
import { EPOCH } from './sync'

/** What Boris reads after a press of the backfill preview. */
export const BACKFILL_TEXTS = {
  running: 'Вношу прошлые отклики в таблицу, это займет несколько минут.',
  declined: 'Хорошо, прошлые отклики в таблицу не вношу.',
  stale: 'Это уже решено.',
}

/**
 * «Внести» moves the start of the sheet back to the first bid, so the next pass writes every past bid (the script
 * takes Boris's own rows instead of adding twins); «Не вносить» leaves the start where it is. Only the preview that
 * is waiting can be answered, and only once.
 */
export async function onSheetPress(
  d: { db: Db; notifier: Pick<Notifier, 'markDone'> },
  action: string,
): Promise<string> {
  if (action !== 'apply' && action !== 'drop') return BACKFILL_TEXTS.stale
  const apply = action === 'apply'
  const rows = await d.db
    .update(sheetSync)
    .set(
      apply
        ? { backfill: 'running', since: EPOCH, failures: 0, nextTryAt: null }
        : { backfill: 'declined' },
    )
    .where(eq(sheetSync.backfill, 'asked'))
    .returning({ messageId: sheetSync.backfillMessageId })
  if (rows.length === 0) return BACKFILL_TEXTS.stale
  const id = rows[0]?.messageId
  if (id) {
    try {
      await d.notifier.markDone?.(id, apply ? 'Вношу' : 'Не вношу')
    } catch (e) {
      console.error('sheet preview not marked', e instanceof Error ? e.message.slice(0, 200) : e)
    }
  }
  return apply ? BACKFILL_TEXTS.running : BACKFILL_TEXTS.declined
}
