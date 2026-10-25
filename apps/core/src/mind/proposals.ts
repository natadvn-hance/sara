import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { newEventId } from '@sara/shared'
import { and, asc, eq, isNull } from 'drizzle-orm'
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

/** The folder must exist and be a clone (its `.git` is a folder, or a file in a linked work tree). */
async function assertClone(root: string): Promise<void> {
  const isDir = await stat(root).then(
    (s) => s.isDirectory(),
    () => false,
  )
  const hasMarker =
    isDir &&
    (await stat(join(root, '.git')).then(
      () => true,
      () => false,
    ))
  if (!hasMarker)
    throw new Error(`${root}: это не папка с клоном sara-mind (нет .git), выкладывать некуда`)
}

/**
 * Writes the new proposals as files under `toDir` (a developer's sara-mind clone) and marks them exported, so the next
 * export skips them. `toDir` must be an existing folder with `.git`. Only `mind/proposals/` and `exam/` are written: a
 * path into `mind/shared/`, `mind/directions/`, `.git/` or out of the clone stops the export before anything is written
 * (the confirmed mind changes only by `mind accept`). A file that is already there is never overwritten: its path goes
 * to `report.existing`, the proposal stays `new`, the others are still written. A proposal of an M5 lesson is never
 * exported: Sara's writer writes it after Boris's «да» (ADR-025, request R9).
 */
export async function exportProposals(
  db: Db,
  toDir: string,
  report: { existing: string[] } = { existing: [] },
): Promise<number> {
  const root = resolve(toDir)
  await assertClone(root)
  const rows = await db
    .select()
    .from(mindProposal)
    .where(and(eq(mindProposal.state, 'new'), isNull(mindProposal.lessonId)))
    .orderBy(asc(mindProposal.createdAt), asc(mindProposal.id))
  const files = rows.map((r) => exportPath(root, r.path))
  let written = 0
  for (const [i, r] of rows.entries()) {
    const file = files[i] as string
    await mkdir(dirname(file), { recursive: true })
    try {
      await writeFile(file, r.content, { flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      report.existing.push(r.path)
      continue
    }
    const done = await db
      .update(mindProposal)
      .set({ state: 'exported', exportedAt: new Date().toISOString() })
      .where(and(eq(mindProposal.id, r.id), eq(mindProposal.state, 'new')))
      .returning({ id: mindProposal.id })
    written += done.length
  }
  return written
}
