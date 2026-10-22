// pnpm mind:check <folder>: every mind record has valid fields at the top (contract C6).
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { MindFrontmatter } from '@sara/shared'
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

export async function checkMind(root: string): Promise<MindProblem[]> {
  const files: string[] = []
  await markdownFiles(root, files)
  const problems: MindProblem[] = []
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
    }
  }
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2]
  if (!target) {
    console.log('Укажи папку: pnpm mind:check <путь к mind>')
    process.exit(1)
  }
  const problems = await checkMind(resolve(target))
  for (const p of problems) console.log(`${p.file}: поле ${p.field}: ${p.message}`)
  if (problems.length > 0) process.exit(1)
  console.log('Разум в порядке')
}
