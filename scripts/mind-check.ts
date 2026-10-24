// pnpm mind:check <folder>: every mind record has valid fields at the top (contract C6, version 2).
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { MIND_ID_PREFIX, MindFrontmatter } from '@sara/shared'
import { parse } from 'yaml'

export type MindProblem = { file: string; field: string; message: string }

async function markdownFiles(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== '.git') await markdownFiles(full, out)
    } else if (e.name.endsWith('.md') && e.name !== 'README.md') {
      out.push(full)
    }
  }
}

/** Where a file lands once accepted: a proposal shares its id only with the record it replaces. */
function target(root: string, file: string): string {
  return relative(root, file)
    .split(sep)
    .filter((p) => p !== 'proposals')
    .join('/')
}

export async function checkMind(root: string): Promise<MindProblem[]> {
  const files: string[] = []
  await markdownFiles(root, files)
  const problems: MindProblem[] = []
  const records: { file: string; front: MindFrontmatter }[] = []
  for (const file of files.sort()) {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(await readFile(file, 'utf8'))
    if (!m) {
      problems.push({ file, field: 'frontmatter', message: 'нет полей сверху между строками ---' })
      continue
    }
    let data: unknown
    try {
      data = parse(m[1] ?? '')
    } catch (e) {
      problems.push({
        file,
        field: 'frontmatter',
        message: `поля сверху не читаются: ${(e as Error).message}`,
      })
      continue
    }
    const r = MindFrontmatter.safeParse(data)
    if (!r.success) {
      for (const issue of r.error.issues) {
        problems.push({
          file,
          field: issue.path.join('.') || 'frontmatter',
          message: issue.message,
        })
      }
      continue
    }
    const prefix = MIND_ID_PREFIX[r.data.type]
    if (!r.data.id.startsWith(prefix)) {
      problems.push({
        file,
        field: 'id',
        message: `номер записи типа ${r.data.type} начинается с ${prefix}`,
      })
    }
    records.push({ file, front: r.data })
  }

  const firstById = new Map<string, { file: string; target: string }>()
  for (const { file, front } of records) {
    const first = firstById.get(front.id)
    if (!first) firstById.set(front.id, { file, target: target(root, file) })
    else if (first.target !== target(root, file))
      problems.push({ file, field: 'id', message: `${front.id} уже есть в ${first.file}` })
  }
  const examples = new Set(records.filter((r) => r.front.type === 'example').map((r) => r.front.id))
  for (const { file, front } of records) {
    for (const id of front.examples ?? []) {
      if (!examples.has(id))
        problems.push({ file, field: 'examples', message: `нет образца с номером ${id}` })
    }
  }
  return problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const folder = process.argv[2]
  if (!folder) {
    console.log('Укажи папку: pnpm mind:check <путь к mind>')
    process.exit(1)
  }
  const problems = await checkMind(resolve(folder))
  for (const p of problems) console.log(`${p.file}: поле ${p.field}: ${p.message}`)
  if (problems.length > 0) process.exit(1)
  console.log('Разум в порядке')
}
