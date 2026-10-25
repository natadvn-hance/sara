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

/** Where an export may write inside a clone: the proposals tree and the exam scenarios, never the confirmed mind. */
const EXPORT_TREES = ['mind/proposals/', 'exam/']

/** The path of a proposal inside the clone, or why it is not allowed. */
function exportPath(root: string, path: string): string {
  const rel = relative(root, resolve(root, path)).split(sep).join('/')
  if (isAbsolute(path) || !EXPORT_TREES.some((t) => rel.startsWith(t)))
    throw new Error(
      `Путь предложения не принимается, писать можно только в mind/proposals/ и exam/: ${path}`,
    )
  return resolve(root, rel)
}

/**
 * Writes the new proposals as files under `toDir` (a developer's sara-mind clone) and marks them exported, so the next
 * export skips them. Only `mind/proposals/` and `exam/` are written: a path into `mind/shared/`, `mind/directions/`,
 * `.git/` or out of the clone stops the export before anything is written (the confirmed mind changes only by
 * `mind accept`).
 */
export async function exportProposals(db: Db, toDir: string): Promise<number> {
  const root = resolve(toDir)
  const rows = await db
    .select()
    .from(mindProposal)
    .where(eq(mindProposal.state, 'new'))
    .orderBy(asc(mindProposal.createdAt), asc(mindProposal.id))
  const files = rows.map((r) => exportPath(root, r.path))
  let written = 0
  for (const [i, r] of rows.entries()) {
    const file = files[i] as string
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
