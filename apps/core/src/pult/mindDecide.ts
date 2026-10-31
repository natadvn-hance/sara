import { newEventId } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { mindProposal } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { MindWriter } from '../school/types'

/**
 * «Да» and «Нет» to a proposal for the mind from the pult (pult v2 design 9, FR-MIND-3). «Нет» closes it with the
 * reason. «Да» marks it accepted and hands it to the one writer of the mind; until the writer has written it, the
 * screen says «ждёт записи». Nothing here writes into the mind by itself.
 */

export const MIND_TEXTS = {
  written: 'Записала в разум.',
  waiting: 'Приняла. Запись в разум ждёт писателя: появится после следующей синхронизации.',
  rejected: 'Не записываю.',
  decided: 'Это предложение уже решено.',
  missing: 'Такого предложения нет.',
} as const

export async function decideProposal(
  d: { db: Db; writer?: MindWriter },
  id: string,
  decision: 'yes' | 'no',
  reason: string | null,
): Promise<{ ok: boolean; message: string }> {
  const [p] = await d.db.select().from(mindProposal).where(eq(mindProposal.id, id))
  if (!p) return { ok: false, message: MIND_TEXTS.missing }
  const now = new Date().toISOString()
  const rows = await d.db
    .update(mindProposal)
    .set({
      state: decision === 'yes' ? 'accepted' : 'rejected',
      decidedAt: now,
      rejectReason: decision === 'no' ? reason : null,
    })
    .where(and(eq(mindProposal.id, id), eq(mindProposal.state, 'new')))
    .returning({ id: mindProposal.id })
  if (rows.length === 0) return { ok: false, message: MIND_TEXTS.decided }
  await appendEvent(d.db, {
    type: 'mind.decided',
    v: 1,
    entity: { kind: 'mind_proposal', id },
    account_id: null,
    actor: 'boris',
    occurred_at: now,
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { decision, kind: p.kind },
  })
  if (decision === 'no') return { ok: true, message: MIND_TEXTS.rejected }
  if (!d.writer) return { ok: true, message: MIND_TEXTS.waiting }
  const r = await d.writer.apply([id], { lessonIds: [], batchId: null }).catch(() => null)
  if (!r?.ok || !r.written.length) return { ok: true, message: MIND_TEXTS.waiting }
  await d.db.update(mindProposal).set({ state: 'written' }).where(eq(mindProposal.id, id))
  return { ok: true, message: MIND_TEXTS.written }
}
