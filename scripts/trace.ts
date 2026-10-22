// pnpm trace: requirement -> milestone -> stories -> tests (docs/quality/traceability.md).
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

export type TraceRow = { id: string; milestone: string; stories: string[]; tests: string[] }
export type TraceInput = {
  specMd: string
  backlogMd: string
  matrixMd: string
  testFiles: { path: string; text: string }[]
}

const REQ = /\b(?:FR|NFR)-[A-Z]+-\d+\b/g

export function buildTrace(i: TraceInput): {
  rows: TraceRow[]
  unknownIds: string[]
  uncovered: string[]
} {
  const ids = [
    ...new Set(
      [...i.specMd.matchAll(/^\|\s*((?:FR|NFR)-[A-Z]+-\d+)\s*\|/gm)].map((m) => m[1] as string),
    ),
  ]

  const milestone = new Map<string, string>()
  for (const line of i.matrixMd.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    for (let k = 0; k < cells.length - 1; k++) {
      const id = cells[k] ?? ''
      if (/^(?:FR|NFR)-[A-Z]+-\d+$/.test(id)) milestone.set(id, cells[k + 1] ?? '')
    }
  }

  const stories = new Map<string, string[]>()
  const add = (id: string, story: string) =>
    stories.set(id, [...new Set([...(stories.get(id) ?? []), story])])
  for (const m of i.backlogMd.matchAll(
    /^### (ST-M\d+-\d+)[^\n]*\n(.*?)(?=^### |^## |$(?![\s\S]))/gms,
  )) {
    const req = /Требования:([^\n]*)/.exec(m[2] ?? '')
    for (const id of req?.[1]?.match(REQ) ?? []) add(id, m[1] as string)
  }
  for (const m of i.backlogMd.matchAll(/^\|\s*(ST-M\d+-\d+)\s*\|[^|]*\|([^|]*)\|/gm)) {
    for (const id of m[2]?.match(REQ) ?? []) add(id, m[1] as string)
  }

  const tests = new Map<string, string[]>()
  const unknown = new Set<string>()
  for (const f of i.testFiles) {
    for (const m of f.text.matchAll(/\b(?:it|test|describe)\(\s*['"`]([^'"`]*)/g)) {
      for (const id of m[1]?.match(REQ) ?? []) {
        if (!ids.includes(id)) unknown.add(id)
        tests.set(id, [...new Set([...(tests.get(id) ?? []), f.path])])
      }
    }
  }

  const rows = ids.map((id) => ({
    id,
    milestone: milestone.get(id) ?? '',
    stories: stories.get(id) ?? [],
    tests: tests.get(id) ?? [],
  }))
  const uncovered = rows
    .filter((r) => /\bM0\b/.test(r.milestone) && r.tests.length === 0)
    .map((r) => r.id)
  return { rows, unknownIds: [...unknown], uncovered }
}

async function testFiles(
  root: string,
  dir: string,
  out: { path: string; text: string }[],
): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (!['node_modules', 'dist', '.git', 'fixtures'].includes(e.name))
        await testFiles(root, full, out)
    } else if (/\.(test|spec)\.tsx?$/.test(e.name)) {
      out.push({ path: relative(root, full), text: await readFile(full, 'utf8') })
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(import.meta.dirname, '..')
  const read = (p: string) => readFile(join(root, p), 'utf8')
  const files: { path: string; text: string }[] = []
  for (const d of ['apps', 'packages', 'tests']) await testFiles(root, join(root, d), files)
  const r = buildTrace({
    specMd: await read('docs/spec/2026-10-22-sara-spec-v1.md'),
    backlogMd: await read('docs/product/backlog.md'),
    matrixMd: await read('docs/quality/traceability.md'),
    testFiles: files,
  })
  const lines = [
    '# Трассируемость: отчёт',
    '',
    '| Требование | Веха | Истории | Тесты |',
    '|---|---|---|---|',
    ...r.rows.map(
      (x) => `| ${x.id} | ${x.milestone} | ${x.stories.join(', ')} | ${x.tests.length} |`,
    ),
  ]
  await mkdir(join(root, 'reports'), { recursive: true })
  await writeFile(join(root, 'reports/traceability.md'), `${lines.join('\n')}\n`)
  const covered = r.rows.filter((x) => x.tests.length > 0).length
  console.log(`Требований: ${r.rows.length}, с тестами: ${covered}. Отчёт: reports/traceability.md`)
  for (const id of r.uncovered) console.log(`Нет теста у требования вехи M0: ${id}`)
  for (const id of r.unknownIds) console.log(`Тест ссылается на неизвестное требование: ${id}`)
  const strict = process.argv.includes('--strict')
  if (r.unknownIds.length > 0 || (strict && r.uncovered.length > 0)) process.exit(1)
}
