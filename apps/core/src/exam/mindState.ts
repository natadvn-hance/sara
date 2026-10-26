import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { event } from '../db/schema'

/**
 * The exam reads the mind through the index the core keeps (`core.mind_index`) and never builds it: rebuilding it
 * would put a candidate mind into the live search before the guard passed. So before a run it compares the version of
 * the mind folder with the version the index was last built for, and refuses to run when they differ.
 *
 * `folderMindVersion` is the rule of `loadMind().mindVersion` in mind/loader.ts (the commit of the clone, else a hash
 * of the records, else `empty`), kept here so the exam can read the folder without loading the records. When both live
 * in one tree, this function should become `(await loadMind(dir)).mindVersion`.
 */

/** The trees an indexed record may live in; `mind/proposals/` and `exam/` are never the mind. */
const TREES = ['mind/shared', 'mind/directions']

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  )
}

async function markdownFiles(dir: string, out: string[]): Promise<void> {
  if (!(await exists(dir))) return
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) await markdownFiles(full, out)
    else if (e.name.endsWith('.md') && e.name !== 'README.md') out.push(full)
  }
}

/** The commit of a clone read from `.git` itself (the core image has no git binary). Null when there is none. */
async function gitHead(root: string): Promise<string | null> {
  const dotGit = join(root, '.git')
  try {
    if (!(await stat(dotGit)).isDirectory()) return null
    const head = (await readFile(join(dotGit, 'HEAD'), 'utf8')).trim()
    const ref = /^ref: (.+)$/.exec(head)?.[1]
    if (!ref) return /^[0-9a-f]{40,64}$/.test(head) ? head : null
    const loose = await readFile(join(dotGit, ref), 'utf8').catch(() => null)
    if (loose) return loose.trim()
    const packed = await readFile(join(dotGit, 'packed-refs'), 'utf8').catch(() => '')
    return (
      packed
        .split('\n')
        .find((l) => l.endsWith(` ${ref}`))
        ?.split(' ')[0] ?? null
    )
  } catch {
    return null
  }
}

/** The version of the mind in a folder; a missing or empty folder is the empty mind. */
export async function folderMindVersion(root: string): Promise<string> {
  if (!(await exists(root))) return 'empty'
  const files: string[] = []
  for (const tree of TREES) await markdownFiles(join(root, tree), files)
  const paths = files.map((f) => relative(root, f).split(sep).join('/')).sort()
  const hash = createHash('sha256')
  for (const path of paths) hash.update(`${path}\n${await readFile(join(root, path), 'utf8')}\n`)
  const head = await gitHead(root)
  return head ?? (paths.length === 0 ? 'empty' : hash.digest('hex').slice(0, 12))
}

/** The mind version the index was last built for, from the journal (`mind.indexed`); null before the first build. */
export async function indexedMindVersion(db: Db): Promise<string | null> {
  const [r] = await db
    .select({ version: event.entityId })
    .from(event)
    .where(eq(event.type, 'mind.indexed'))
    .orderBy(desc(event.recordedAt), desc(event.occurredAt))
    .limit(1)
  return r?.version ?? null
}

export type MindState = { folder: string; indexed: string | null }

/** Reads the two versions; writes nothing. */
export async function readMindState(db: Db, mindDir: string): Promise<MindState> {
  return { folder: await folderMindVersion(mindDir), indexed: await indexedMindVersion(db) }
}

/** Why the exam cannot run against this index, in plain words; null when the index is the folder's mind. */
export function mindStateProblem(s: MindState): string | null {
  if ((s.indexed ?? 'empty') === s.folder) return null
  return `Индекс разума построен для ${s.indexed ?? 'пустого разума'}, а в папке разума ${s.folder}. Экзамен индекс не обновляет: он проверяет то, что сейчас работает. Пусть ядро обновит индекс (оно делает это при запуске и раз в час) или проверь SARA_MIND_DIR.`
}
