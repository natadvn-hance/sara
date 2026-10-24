import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { newEventId } from '@sara/shared'
import { and, asc, eq } from 'drizzle-orm'
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
 * Writes the new proposals as files under `toDir` (a developer's sara-mind clone) and marks them exported, so the next
 * export skips them. A path that would leave `toDir` stops the export before anything is written.
 */
export async function exportProposals(db: Db, toDir: string): Promise<number> {
  const root = resolve(toDir)
  const rows = await db
    .select()
    .from(mindProposal)
    .where(eq(mindProposal.state, 'new'))
    .orderBy(asc(mindProposal.createdAt), asc(mindProposal.id))
  for (const r of rows) {
    const rel = relative(root, resolve(root, r.path))
    if (isAbsolute(r.path) || rel === '' || rel === '..' || rel.startsWith(`..${sep}`))
      throw new Error(`Путь предложения выходит из папки клона: ${r.path}`)
  }
  let written = 0
  for (const r of rows) {
    const file = resolve(root, r.path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, r.content)
    const done = await db
      .update(mindProposal)
      .set({ state: 'exported', exportedAt: new Date().toISOString() })
      .where(and(eq(mindProposal.id, r.id), eq(mindProposal.state, 'new')))
      .returning({ id: mindProposal.id })
    written += done.length
  }
  return written
}
