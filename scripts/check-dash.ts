import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DASH = String.fromCharCode(0x2014)
const SKIP_DIRS = new Set([
  'node_modules',
  'docs',
  'dist',
  '.git',
  '.sara',
  '.superpowers',
  'reports',
])
const EXTENSIONS = /\.(ts|tsx|js|mjs|json|md|css|html)$/

export type DashHit = { file: string; line: number }

async function walk(path: string, hits: DashHit[]): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true })
  for (const e of entries) {
    const full = join(path, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(full, hits)
    } else if (EXTENSIONS.test(e.name)) {
      const lines = (await readFile(full, 'utf8')).split('\n')
      lines.forEach((text, i) => {
        if (text.includes(DASH)) hits.push({ file: full, line: i + 1 })
      })
    }
  }
}

export async function findLongDashes(paths: string[]): Promise<DashHit[]> {
  const hits: DashHit[] = []
  for (const p of paths) await walk(p, hits)
  return hits
}

const ROOTS = ['apps', 'packages', 'roles', 'tests', 'scripts']

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(import.meta.dirname, '..')
  const existing = []
  for (const r of ROOTS) {
    try {
      await readdir(join(root, r))
      existing.push(join(root, r))
    } catch {}
  }
  const hits = await findLongDashes(existing)
  for (const h of hits) console.log(`${h.file}:${h.line}`)
  if (hits.length > 0) {
    console.log('Найдено длинное тире. Замени его запятой, точкой, двоеточием или дефисом.')
    process.exit(1)
  }
}
