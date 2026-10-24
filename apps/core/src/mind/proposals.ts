import { newEventId } from '@sara/shared'
import type { Db, DbOrTx } from '../db/client'
import { mindProposal } from '../db/schema'
import { appendEvent } from '../journal/journal'

export type ProposalKind = 'example' | 'knowledge' | 'scenario' | 'other'

/**
 * Keeps a file Sara proposes for the mind (FR-MIND-3). The core never writes into the mind folder: a developer
 * exports the proposals and Boris says «да» (M4 design 5.2). False when a proposal with this path already exists.
 */
export async function proposeMind(
  db: DbOrTx,
  p: { path: string; content: string; kind: ProposalKind; source: string },
): Promise<boolean> {
  const id = newEventId()
  const rows = await db
    .insert(mindProposal)
    .values({ id, ...p })
    .onConflictDoNothing()
    .returning({ id: mindProposal.id })
  if (rows.length === 0) return false
  await appendEvent(db, {
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
}

/** Writes the new proposals as files under `toDir` and marks them exported. Part B writes the body. */
export async function exportProposals(_db: Db, _toDir: string): Promise<number> {
  throw new Error('mind proposals export is not built')
}
