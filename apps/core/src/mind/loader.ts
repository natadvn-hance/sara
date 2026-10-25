import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { MindFrontmatter } from '@sara/shared'
import { parse } from 'yaml'

export type MindRecord = {
  /** Relative to the clone root, with forward slashes: `mind/shared/knowledge/k-price.md`. */
  path: string
  front: MindFrontmatter
  title: string
  /** The Markdown after the fields, without the first-level title line. */
  body: string
  /** Second-level sections by their heading: `## Клиент` → `sections['Клиент']`. */
  sections: Record<string, string>
}

export type LoadedMind = {
  records: MindRecord[]
  mindVersion: string
  errors: { path: string; message: string }[]
}

/** The trees an indexed record may live in; `mind/proposals/` and `exam/` are never read (FR-MIND-3). */
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

/** The commit of a clone read from `.git` itself: the core image has no git binary. Null when there is none. */
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

/** One record file at `path` (relative to the clone root): its fields, title, body and sections, or why not. */
export function parseRecord(
  path: string,
  text: string,
): { record: MindRecord } | { error: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return { error: 'нет полей сверху между строками ---' }
  let data: unknown
  try {
    data = parse(m[1] ?? '')
  } catch (e) {
    return { error: `поля сверху не читаются: ${(e as Error).message}` }
  }
  const r = MindFrontmatter.safeParse(data)
  if (!r.success) {
    return {
      error: r.error.issues
        .map((i) => `поле ${i.path.join('.') || 'frontmatter'}: ${i.message}`)
        .join('; '),
    }
  }
  const front = r.data
  const scope = /^mind\/directions\/([^/]+)\//.exec(path)?.[1] ?? 'shared'
  if (front.scope !== scope) return { error: `поле scope: в этой папке должно быть ${scope}` }

  let body = (m[2] ?? '').trim()
  const heading = /^# (.+)\n*/.exec(body)
  if (heading) body = body.slice(heading[0].length).trim()
  const title = front.title ?? heading?.[1]?.trim() ?? front.id
  return { record: { path, front, title, body, sections: markdownSections(body) } }
}

/** The second-level sections of a record body by their heading. */
export function markdownSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {}
  for (const part of body.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n')
    const name = (nl < 0 ? part : part.slice(0, nl)).trim()
    sections[name] = nl < 0 ? '' : part.slice(nl + 1).trim()
  }
  return sections
}

/**
 * Reads the confirmed mind of a sara-mind clone (FR-MIND-1): `mind/shared/**` and `mind/directions/**`. The version is
 * the clone's commit, without git a hash of the paths and contents. A missing folder is the empty mind.
 */
export async function loadMind(root: string): Promise<LoadedMind> {
  if (!(await exists(root))) return { records: [], mindVersion: 'empty', errors: [] }
  const files: string[] = []
  for (const tree of TREES) await markdownFiles(join(root, tree), files)
  const paths = files.map((f) => relative(root, f).split(sep).join('/')).sort()

  const hash = createHash('sha256')
  const parsed: ({ path: string } & ({ record: MindRecord } | { error: string }))[] = []
  for (const path of paths) {
    const text = await readFile(join(root, path), 'utf8')
    hash.update(`${path}\n${text}\n`)
    parsed.push({ path, ...parseRecord(path, text) })
  }

  // One id, one record: byIds has no scope, so a direction copy of a shared id would reach every account. The shared
  // copy wins; between directions the first path does. The others are errors.
  const winners = new Map<string, MindRecord>()
  for (const p of parsed) {
    if (!('record' in p)) continue
    const have = winners.get(p.record.front.id)
    if (!have || (have.front.scope !== 'shared' && p.record.front.scope === 'shared'))
      winners.set(p.record.front.id, p.record)
  }
  const records: MindRecord[] = []
  const errors: LoadedMind['errors'] = []
  for (const p of parsed) {
    if ('error' in p) {
      errors.push({ path: p.path, message: p.error })
      continue
    }
    const winner = winners.get(p.record.front.id)
    if (winner === p.record) records.push(p.record)
    else
      errors.push({
        path: p.path,
        message: `поле id: ${p.record.front.id} уже есть в ${winner?.path}`,
      })
  }
  const head = await gitHead(root)
  const mindVersion = head ?? (paths.length === 0 ? 'empty' : hash.digest('hex').slice(0, 12))
  return { records, mindVersion, errors }
}
