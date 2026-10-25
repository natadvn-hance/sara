import { newEventId } from '@sara/shared'
import type { Db, DbOrTx } from '../db/client'
import { mindProposal } from '../db/schema'
import { appendEvent } from '../journal/journal'

export type ProposalKind =
  | 'example'
  | 'knowledge'
  | 'scenario'
  | 'other'
  // M5: drafts of the night teacher and the starting mind.
  | 'understanding'
  | 'speech'
  | 'judgment'

/**
 * Keeps a file Sara proposes for the mind (FR-MIND-3). The core never writes into the mind folder: a developer
 * exports the proposals and Boris says «да» (M4 design 5.2). False when a proposal with this path already exists.
 */
export async function proposeMind(
  db: DbOrTx,
  p: {
    path: string
    content: string
    kind: ProposalKind
    source: string
    // M5 (ADR-025): the lesson Boris says «да» to, and what the mind writer builds the file from.
    lessonId?: string
    action?: 'create' | 'update' | 'outdate'
    recordId?: string
    section?: string | null
    baseVersion?: number | null
    change?: unknown
  },
): Promise<boolean> {
  const id = newEventId()
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(mindProposal)
      .values({ id, ...p })
      .onConflictDoNothing()
      .returning({ id: mindProposal.id })
    if (rows.length === 0) return false
    await appendEvent(tx, {
      type: 'mind.proposed',
      v: 1,
      entity: { kind: 'mind_proposal', id },
      account_id: null,
      actor: 'sara',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: id,
      reason: null,
      payload: { kind: p.kind },
    })
    return true
  })
}

/**
 * Writes the new proposals as files under `toDir` and marks them exported. Part B writes the body; it skips rows with
 * a `lesson_id` (M5 writes those itself after Boris's «да», ADR-025) and declined ones.
 */
export async function exportProposals(_db: Db, _toDir: string): Promise<number> {
  throw new Error('mind proposals export is not built')
}
